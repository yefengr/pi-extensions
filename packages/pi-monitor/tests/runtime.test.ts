import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MAX_RECENT_TASKS, NOTIFICATION_TYPE, RESULT_TYPE, STATE_TYPE } from "../src/constants.ts";
import type { CheckResult } from "../src/types.ts";
import { eventually, installedPiRoot, installHostAliases } from "./helpers.ts";

installHostAliases();
const { registerMonitor } = await import("../src/extension.ts");

// 监听默认写项目日志；用临时工作区避免测试污染仓库工作树。
const workspace = mkdtempSync(path.join(tmpdir(), "monitor-runtime-"));
process.on("exit", () => rmSync(workspace, { recursive: true, force: true }));

function host(check: (_record: any, signal: AbortSignal) => Promise<CheckResult> = async () => ({ state: "ok", events: [{ id: "event-1", summary: "完成" }] })) {
  const handlers = new Map<string, any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const entries: any[] = [];
  const messages: any[] = [];
  const notifications: any[] = [];
  const confirmations: any[] = [];
  const statuses: any[] = [];
  let idle = true;
  let queued = false;
  let owner = "owner-1";
  let branch = entries;
  let durable = true;
  let failWrites = false;
  let failAck = false;
  let nextEntryId = 0;
  let persistMessages = true;
  const pendingAtMessageEnd: number[] = [];
  const ctx: any = {
    cwd: workspace, mode: "tui", hasUI: true, isIdle: () => idle, hasPendingMessages: () => queued,
    sessionManager: { getSessionId: () => owner, getBranch: () => [...branch] },
    ui: {
      confirm: (...args: any[]) => { confirmations.push(args); throw new Error("监听不应请求用户确认"); },
      notify: (...args: any[]) => notifications.push(args),
      setStatus: (...args: any[]) => statuses.push(args),
    },
  };
  const api: any = {
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerMessageRenderer() {}, registerEntryRenderer() {},
    appendEntry: (customType: string, data: any) => {
      branch.push({ id: `entry-${++nextEntryId}`, type: "custom", customType, data: structuredClone(data) });
      if (customType === STATE_TYPE && (failWrites || (failAck && data.record.lastResult && data.record.pending.length === 0))) throw new Error("disk full after memory append");
    },
    sendMessage: (message: any, options: any) => {
      messages.push({ message, options });
      handlers.get("message_end")({ message: { role: "custom", ...message } }, ctx);
      pendingAtMessageEnd.push(runtime.records(ctx).reduce((n, task) => n + task.pending.length, 0));
      if (persistMessages) branch.push({ id: `entry-${++nextEntryId}`, type: "custom_message", ...structuredClone(message) });
    },
  };
  const runtime = registerMonitor(api, { check, deliveryWindowMs: 5, isDurable: () => durable, confirmedReceiptIds: (_ctx, entries) => new Set(entries.map((entry) => entry.id!)) });
  handlers.get("session_start")({ reason: "startup" }, ctx);
  return {
    runtime, entries, messages, notifications, confirmations, statuses, ctx, handlers, pendingAtMessageEnd,
    persistMessages(value: boolean) { persistMessages = value; },
    idle(value: boolean) { idle = value; }, queued(value: boolean) { queued = value; },
    owner(value: string) { owner = value; }, branch(value: any[]) { branch = value; },
    durable(value: boolean) { durable = value; }, failWrites(value: boolean) { failWrites = value; },
    failAck(value: boolean) { failAck = value; },
    async call(input: any, signal?: AbortSignal) { return tools.get("monitor").execute("call", input, signal, undefined, ctx); },
    async command(args: string) { return commands.get("monitor").handler(args, ctx); },
  };
}
const start = (extra: Record<string, unknown> = {}) => ({ action: "start", name: "构建状态", purpose: "解释构建结果", mode: "once", command: process.execPath, args: ["check.js"], ...extra });

test("registration returns immediately; once delivers batch and reload does not duplicate", async (t) => {
  const h = host(); t.after(() => h.runtime.dispose());
  const result = await h.call(start());
  const id = result.details.tasks[0].id;
  assert.equal(h.confirmations.length, 0);
  await eventually(() => h.messages.length === 1 && h.runtime.record(h.ctx, id).pending.length === 0);
  assert.deepEqual(h.pendingAtMessageEnd, [1]);
  assert.equal(h.runtime.record(h.ctx, id).status, "completed");
  assert.equal(h.runtime.record(h.ctx, id).pending.length, 0);
  assert.equal(h.messages[0].options.deliverAs, "followUp");
  assert.equal(h.messages[0].options.triggerTurn, true);
  assert.match(h.messages[0].message.content, /不是用户的新指令/);
  h.handlers.get("session_start")({ reason: "reload" }, h.ctx);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.messages.length, 1);
});

test("relaunch recreates a stopped task with a new id and the original definition", async (t) => {
  const h = host(); t.after(() => h.runtime.dispose());
  const created = await h.call(start({ name: "relaunch-me", intervalSeconds: 5, autoResume: true }));
  const id = created.details.tasks[0].id;
  await h.call({ action: "stop", id });
  const again = h.runtime.relaunch(h.ctx, id);
  assert.notEqual(again.id, id);
  assert.equal(again.name, "relaunch-me");
  assert.equal(again.intervalMs, 5_000);
  assert.equal(again.status, "running");
  assert.equal(again.autoResume, true);
  assert.deepEqual(again.seenIds, []);
});

test("relaunch rejects running tasks and tasks with pending results", async (t) => {
  const h = host(); t.after(() => h.runtime.dispose());
  const running = await h.call(start({ name: "running" }));
  assert.throws(() => h.runtime.relaunch(h.ctx, running.details.tasks[0].id), /正在运行/);
  h.idle(false);
  const once = await h.call(start({ name: "pending", mode: "once" }));
  const id = once.details.tasks[0].id;
  await eventually(() => h.runtime.record(h.ctx, id).pending.length === 1);
  assert.throws(() => h.runtime.relaunch(h.ctx, id), /待回传/);
});

test("startup and resume only continue tasks with autoResume; fork never does", async (t) => {
  const h = host(); t.after(() => h.runtime.dispose());
  const keep = await h.call(start({ name: "keep", autoResume: true }));
  const wait = await h.call(start({ name: "wait" }));
  const keepId = keep.details.tasks[0].id;
  const waitId = wait.details.tasks[0].id;
  h.handlers.get("session_start")({ reason: "startup" }, h.ctx);
  assert.equal(h.runtime.record(h.ctx, keepId).status, "running");
  assert.equal(h.runtime.record(h.ctx, waitId).status, "paused");
  h.handlers.get("session_start")({ reason: "resume" }, h.ctx);
  assert.equal(h.runtime.record(h.ctx, keepId).status, "running");
  h.handlers.get("session_start")({ reason: "fork" }, h.ctx);
  assert.equal(h.runtime.record(h.ctx, keepId).status, "paused");
});

test("busy agent and user queue keep results local until settled and idle", async (t) => {
  const h = host(); t.after(() => h.runtime.dispose());
  h.idle(false);
  const result = await h.call(start());
  const id = result.details.tasks[0].id;
  await eventually(() => h.runtime.record(h.ctx, id).pending.length === 1);
  assert.equal(h.messages.length, 0);
  h.idle(true); h.queued(true);
  h.handlers.get("agent_settled")({}, h.ctx);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(h.messages.length, 0);
  h.queued(false); h.handlers.get("agent_settled")({}, h.ctx);
  await eventually(() => h.messages.length === 1);
});

test("pure notifications persist outside model context, including multiple tasks", async (t) => {
  const h = host(); t.after(() => h.runtime.dispose());
  await h.call(start({ delivery: "notify" }));
  await h.call(start({ delivery: "notify" }));
  await eventually(() => h.entries.filter((entry) => entry.customType === NOTIFICATION_TYPE).length === 2 && h.runtime.records(h.ctx).every((task) => task.pending.length === 0));
  assert.equal(h.messages.length, 0);
  assert.equal(h.entries.some((entry) => entry.type === "custom_message"), false);
  assert.ok(h.runtime.records(h.ctx).every((task) => task.pending.length === 0));
});

test("new process stays paused until explicit resume without confirmation; fork cannot inherit commands", async (t) => {
  let checks = 0;
  const h = host(async () => { checks++; return { state: "ok", events: [] }; });
  t.after(() => h.runtime.dispose());
  const result = await h.call(start({ mode: "continuous" }));
  const id = result.details.tasks[0].id;
  await eventually(() => checks === 1);
  h.handlers.get("session_start")({ reason: "startup" }, h.ctx);
  assert.equal(h.runtime.record(h.ctx, id).status, "paused");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(checks, 1);
  await h.call({ action: "resume", id });
  await eventually(() => checks === 2);
  assert.equal(h.confirmations.length, 0);
  h.owner("fork-owner");
  h.handlers.get("session_start")({ reason: "fork" }, h.ctx);
  assert.deepEqual(h.runtime.records(h.ctx), []);
});

test("tree navigation and shutdown discard late checks", async (t) => {
  let finish: (result: CheckResult) => void = () => {};
  let aborted = false;
  const h = host(async (_task, signal) => {
    signal.addEventListener("abort", () => { aborted = true; });
    return new Promise((resolve) => { finish = resolve; });
  });
  t.after(() => h.runtime.dispose());
  await h.call(start());
  await eventually(() => h.runtime.records(h.ctx).length === 1 && h.entries.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  h.handlers.get("session_before_tree")({}, h.ctx);
  assert.equal(aborted, true);
  h.branch([]); h.handlers.get("session_tree")({}, h.ctx);
  finish({ state: "ok", events: [{ id: "late", summary: "迟到结果" }] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.messages.length, 0);
  assert.equal(h.runtime.records(h.ctx).length, 0);
});

test("aborted, unsupported and stale starts never mutate state", async (t) => {
  const h = host(); t.after(() => h.runtime.dispose());
  const controller = new AbortController(); controller.abort();
  assert.deepEqual((await h.call(start(), controller.signal)).details.tasks, []);
  for (const mode of ["print", "json"]) {
    h.ctx.mode = mode; h.ctx.hasUI = false;
    await assert.rejects(h.call(start()), /非交互/);
  }
  h.ctx.mode = "tui"; h.ctx.hasUI = true;
  h.owner("stale-owner");
  await assert.rejects(h.call(start()), /切换/);
  h.owner("owner-1"); h.runtime.dispose();
  await assert.rejects(h.call(start()), /尚未就绪/);
  assert.equal(h.confirmations.length, 0);
  assert.equal(h.entries.filter((entry) => entry.customType === STATE_TYPE).length, 0);
});

test("RPC start and resume work without UI confirmation capability; aborted resume stays paused", async (t) => {
  const h = host(async () => ({ state: "ok", events: [] })); t.after(() => h.runtime.dispose());
  h.ctx.mode = "rpc"; h.ctx.hasUI = false;
  const result = await h.call(start({ mode: "continuous" }));
  const id = result.details.tasks[0].id;
  h.handlers.get("session_before_tree")({}, h.ctx);
  const controller = new AbortController(); controller.abort();
  assert.deepEqual((await h.call({ action: "resume", id }, controller.signal)).details.tasks, []);
  assert.equal(h.runtime.record(h.ctx, id).status, "paused");
  h.durable(false);
  await assert.rejects(h.call({ action: "resume", id }), /尚未落盘/);
  h.durable(true);
  await h.call({ action: "resume", id });
  assert.equal(h.runtime.record(h.ctx, id).status, "running");
  assert.equal(h.confirmations.length, 0);
});

test("automatic explanation allows stopping only the delivered tasks", (t) => {
  const h = host(); t.after(() => h.runtime.dispose());
  const receipt = { ownerSessionId: "owner-1", deliveries: [{ taskId: "task-1", batchIds: ["batch-1"] }] };
  h.handlers.get("before_agent_start")({ messageType: "custom", message: { role: "custom", customType: RESULT_TYPE, details: receipt } }, h.ctx);
  const guard = h.handlers.get("tool_call");
  assert.equal(guard({ toolName: "write", input: {} }, h.ctx).block, true);
  for (const action of ["start", "resume"]) {
    assert.equal(guard({ toolName: "monitor", input: { action } }, h.ctx).block, true);
  }
  assert.equal(guard({ toolName: "monitor", input: { action: "stop" } }, h.ctx).block, true);
  assert.equal(guard({ toolName: "monitor", input: { action: "stop", id: "task-2" } }, h.ctx).block, true);
  assert.equal(guard({ toolName: "monitor", input: { action: "stop", id: "task-1" } }, h.ctx), undefined);
  assert.equal(guard({ toolName: "monitor", input: { action: "status" } }, h.ctx), undefined);
  assert.equal(guard({ toolName: "monitor", input: { action: "list" } }, h.ctx), undefined);
  h.handlers.get("before_agent_start")({ messageType: "user" }, h.ctx);
  assert.equal(guard({ toolName: "write", input: {} }, h.ctx), undefined);
});

test("reload restores explanation stop scope from the delivered receipt", (t) => {
  const h = host(); t.after(() => h.runtime.dispose());
  const guard = h.handlers.get("tool_call");
  h.entries.push({
    id: "guard-source", type: "custom_message", customType: RESULT_TYPE,
    details: { ownerSessionId: "owner-1", deliveries: [{ taskId: "task-1", batchIds: ["batch-1"] }] },
  });
  h.idle(false);
  h.handlers.get("session_start")({ reason: "reload" }, h.ctx);
  assert.equal(guard({ toolName: "write", input: {} }, h.ctx).block, true);
  assert.equal(guard({ toolName: "monitor", input: { action: "stop", id: "task-1" } }, h.ctx), undefined);
  assert.equal(guard({ toolName: "monitor", input: { action: "stop", id: "task-2" } }, h.ctx).block, true);
  h.handlers.get("before_agent_start")({ messageType: "user" }, h.ctx);
  assert.equal(guard({ toolName: "write", input: {} }, h.ctx), undefined);
});

test("command start parses JSON with spaces and list/show/stop work", async (t) => {
  const h = host(async () => ({ state: "ok", events: [] })); t.after(() => h.runtime.dispose());
  const { action: _action, ...input } = start({ name: "contains spaces" });
  await h.command(`start ${JSON.stringify(input)}`);
  const id = h.runtime.records(h.ctx)[0].id;
  await h.command("list"); await h.command(`show ${id}`);
  h.handlers.get("session_before_tree")({}, h.ctx);
  await h.command(`resume ${id}`);
  assert.equal(h.runtime.record(h.ctx, id).status, "running");
  await h.command(`stop ${id}`);
  assert.equal(h.runtime.record(h.ctx, id).status, "stopped");
  assert.equal(h.confirmations.length, 0);
  assert.ok(h.notifications.some(([message]) => message.includes("contains spaces")));
});

test("unpersisted sessions are rejected and failed append compensates memory before reload", async (t) => {
  let finish: (result: CheckResult) => void = () => {};
  let checking = false;
  const h = host(async () => { checking = true; return new Promise((resolve) => { finish = resolve; }); });
  t.after(() => h.runtime.dispose());
  h.durable(false);
  await assert.rejects(h.call(start()), /尚未落盘/);
  assert.equal(h.confirmations.length, 0);
  h.durable(true);
  const result = await h.call(start());
  const id = result.details.tasks[0].id;
  await eventually(() => checking);
  h.failWrites(true);
  finish({ state: "ok", cursor: "uncommitted", events: [{ id: "event", summary: "未提交" }] });
  await eventually(() => h.runtime.record(h.ctx, id).status === "paused");
  h.handlers.get("session_start")({ reason: "reload" }, h.ctx);
  assert.equal(h.runtime.record(h.ctx, id).cursor, undefined);
  assert.equal(h.runtime.record(h.ctx, id).pending.length, 0);
  assert.equal(h.runtime.record(h.ctx, id).status, "paused");
  assert.equal(h.messages.length, 0);
});

test("bounded previews retain full event evidence after delivery", async (t) => {
  const full = { text: "x".repeat(2_000), result: "完整结果" };
  const h = host(async () => ({ state: "ok", events: [{ id: "event", summary: "s".repeat(500), data: full }] }));
  t.after(() => h.runtime.dispose());
  const result = await h.call(start());
  const id = result.details.tasks[0].id;
  await eventually(() => h.messages.length === 1);
  const batchId = h.messages[0].message.details.deliveries[0].batchIds[0];
  assert.ok(h.messages[0].message.content.length < 32_000);
  assert.equal(h.runtime.record(h.ctx, id).pending.length, 0);
  const evidence = await h.call({ action: "status", id, batchId, eventId: "event" });
  assert.deepEqual(evidence.details.tasks[0].event.data, full);
  const catalog = await h.call({ action: "status", id, batchId });
  assert.equal(catalog.details.tasks[0].events[0].summary.length, 500);
});

test("unconfirmed async delivery survives and explicit resume retries", async (t) => {
  const h = host(); t.after(() => h.runtime.dispose());
  h.persistMessages(false);
  const result = await h.call(start());
  const id = result.details.tasks[0].id;
  await eventually(() => h.messages.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.runtime.record(h.ctx, id).pending.length, 1);
  h.handlers.get("agent_settled")({}, h.ctx);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.messages.length, 1);
  h.persistMessages(true);
  await h.call({ action: "resume", id });
  await eventually(() => h.messages.length === 2 && h.runtime.record(h.ctx, id).pending.length === 0);
});

test("cancelled tree navigation clears timer and allows pending-only resume", async (t) => {
  const h = host(); t.after(() => h.runtime.dispose());
  h.idle(false);
  const result = await h.call(start());
  const id = result.details.tasks[0].id;
  await eventually(() => h.runtime.record(h.ctx, id).pending.length === 1);
  h.idle(true); h.handlers.get("agent_settled")({}, h.ctx);
  h.handlers.get("session_before_tree")({}, h.ctx); // 没有随后 session_tree：模拟取消导航。
  await h.call({ action: "resume", id });
  await eventually(() => h.messages.length === 1 && h.runtime.record(h.ctx, id).pending.length === 0);
});

test("ack storage recovery reconciles receipt without notifying or checking twice", async (t) => {
  let checks = 0;
  const h = host(async () => { checks++; return { state: "ok", events: [{ id: "one", summary: "完成" }] }; });
  t.after(() => h.runtime.dispose());
  h.failAck(true);
  const result = await h.call(start({ delivery: "notify" }));
  const id = result.details.tasks[0].id;
  await eventually(() => h.runtime.record(h.ctx, id).status === "paused");
  assert.equal(h.runtime.record(h.ctx, id).resumeStatus, "completed");
  const before = h.notifications.filter(([message]) => message.includes("个新事件")).length;
  await assert.rejects(h.call({ action: "resume", id }), /回执已落盘/);
  h.handlers.get("agent_settled")({}, h.ctx);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.notifications.filter(([message]) => message.includes("个新事件")).length, before);
  assert.equal(h.runtime.record(h.ctx, id).status, "paused");
  h.failAck(false);
  await h.call({ action: "resume", id });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.runtime.record(h.ctx, id).status, "completed");
  assert.equal(h.runtime.record(h.ctx, id).pending.length, 0);
  assert.equal(h.notifications.filter(([message]) => message.includes("个新事件")).length, before);
  assert.equal(checks, 1);
});

test("direct start, resume and stop accept concurrent requests without confirmation locks", async (t) => {
  const h = host(async () => ({ state: "ok", events: [] })); t.after(() => h.runtime.dispose());
  const results = await Promise.all([h.call(start({ mode: "continuous" })), h.call(start({ mode: "continuous" }))]);
  const ids = results.map((result) => result.details.tasks[0].id);
  h.handlers.get("session_before_tree")({}, h.ctx);
  await Promise.all(ids.map((id) => h.call({ action: "resume", id })));
  assert.ok(ids.every((id) => h.runtime.record(h.ctx, id).status === "running"));
  await Promise.all(ids.map((id) => h.call({ action: "stop", id })));
  assert.ok(ids.every((id) => h.runtime.record(h.ctx, id).status === "stopped"));
  assert.equal(h.confirmations.length, 0);
});

test("list and runtime indexes are bounded while old IDs stay queryable from history", async (t) => {
  const h = host(async () => ({ state: "ok", events: [] })); t.after(() => h.runtime.dispose());
  let oldest = "";
  for (let n = 0; n < MAX_RECENT_TASKS + 5; n++) {
    const result = await h.call(start());
    const id = result.details.tasks[0].id;
    oldest ||= id;
    await h.call({ action: "stop", id });
  }
  assert.equal(h.runtime.records(h.ctx).length, MAX_RECENT_TASKS);
  assert.equal(h.runtime.record(h.ctx, oldest).status, "stopped");
  assert.equal((await h.call({ action: "list" })).details.tasks.length, 0);
  assert.equal((await h.call({ action: "list", all: true })).details.tasks.length, MAX_RECENT_TASKS);
  const binding = (h.runtime as any).binding;
  assert.ok(binding.allowed.size <= MAX_RECENT_TASKS);
  assert.ok(binding.statuses.size <= MAX_RECENT_TASKS);
  h.handlers.get("session_start")({ reason: "reload" }, h.ctx);
  assert.equal(h.runtime.records(h.ctx).length, MAX_RECENT_TASKS);
  assert.equal(h.runtime.record(h.ctx, oldest).status, "stopped");
});

test("real Pi SDK loads package entry and registers extension without starting resources", async () => {
  const root = installedPiRoot();
  const sdk = await import(pathToFileURL(path.join(root, "dist", "core", "extensions", "loader.js")).href);
  const result = await sdk.loadExtensions([fileURLToPath(new URL("../index.ts", import.meta.url))], process.cwd());
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  assert.ok(result.extensions[0].tools.has("monitor"));
  assert.ok(result.extensions[0].commands.has("monitor"));
});
