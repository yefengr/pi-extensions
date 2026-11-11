import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SESSION_NAME_OWNER_TYPE } from "../src/session-name.ts";
import { formatTaskStatusResult } from "../src/render.ts";

// 默认配置 fallback，不读写用户目录。
process.env.PI_CODING_AGENT_DIR = path.join(tmpdir(), "task-status-lifecycle-missing-agent");
const extensionFactory = (await import("../index.ts")).default;

type Entry = { type: string; id?: string; parentId?: string | null; timestamp?: string; name?: string; customType?: string; data?: unknown };
type ToolResult = { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean };
type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
interface RegisteredTool {
  name: string;
  execute(id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: ExtensionContext): Promise<ToolResult>;
}

function createSessionContext(initialBranch: Entry[], hasUI = true) {
  let branch = [...initialBranch];
  const allEntries = [...initialBranch];
  const statusCalls: Array<{ key: string; text: string | undefined }> = [];
  let entriesReads = 0;
  let nextId = 0;
  const ctx = {
    hasUI,
    ui: {
      theme: { fg: (color: string, text: string) => {
        assert.equal(color, "dim");
        return dimStatus(text);
      } },
      setStatus: (key: string, text: string | undefined) => statusCalls.push({ key, text }),
    },
    sessionManager: {
      getBranch: () => [...branch],
      getEntries: () => { entriesReads += 1; return [...allEntries]; },
    },
  } as unknown as ExtensionContext;
  return {
    ctx, statusCalls, allEntries,
    entriesReads: () => entriesReads,
    setBranch(entries: Entry[]) { branch = [...entries]; },
    append(entry: Entry) {
      do { nextId += 1; } while (allEntries.some((existing) => existing.id === `host-${nextId}`));
      const saved = { ...entry, id: `host-${nextId}`, parentId: branch.at(-1)?.id ?? null, timestamp: new Date().toISOString() };
      allEntries.push(saved);
      branch.push(saved);
      return saved;
    },
  };
}

function createExtensionHost(initialBranch: Entry[] = [], hasUI = true) {
  const session = createSessionContext(initialBranch, hasUI);
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, EventHandler>();
  const entries: Entry[] = [];
  let activeTools = ["update_task_status"];
  let nameReads = 0;
  const nameWrites: string[] = [];
  let failure: "state" | "get" | "set" | "marker" | "missing-info" | "race" | undefined;
  const api = {
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
    on: (event: string, handler: EventHandler) => handlers.set(event, handler),
    appendEntry(customType: string, data: unknown) {
      if (customType === "task-status-state" && failure === "state") throw new Error("state 写入失败");
      if (customType === SESSION_NAME_OWNER_TYPE && failure === "marker") throw new Error("marker 写入失败");
      entries.push(session.append({ type: "custom", customType, data }));
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => { activeTools = [...names]; },
    getSessionName() {
      nameReads += 1;
      if (failure === "get") throw new Error("名称读取失败");
      return session.allEntries.findLast((entry) => entry.type === "session_info")?.name?.trim() || undefined;
    },
    setSessionName(name: string) {
      if (failure === "set") throw new Error("名称写入失败");
      nameWrites.push(name);
      if (failure === "missing-info") return;
      session.append({ type: "session_info", name: name.replace(/[\r\n]+/g, " ").trim() });
      if (failure === "race") session.append({ type: "session_info", name });
    },
  } as unknown as ExtensionAPI;
  extensionFactory(api);
  return {
    api, entries, session, nameWrites,
    activeTools: () => [...activeTools],
    nameReads: () => nameReads,
    failAt: (value: typeof failure) => { failure = value; },
    manualName: (name: string) => session.append({ type: "session_info", name }),
    async emit(event: string, arg: unknown = {}) {
      const handler = handlers.get(event);
      assert.ok(handler, `扩展未注册 ${event}`);
      return await handler(arg, session.ctx);
    },
    async execute(overrides: Record<string, unknown> = {}) {
      const tool = tools.get("update_task_status");
      assert.ok(tool);
      return await tool.execute("call", {
        taskTransition: "continue", taskName: "修复扩展", status: "in_progress", phase: "实现", progressPercent: 10,
        ...overrides,
      }, undefined, undefined, session.ctx);
    },
  };
}

type Host = ReturnType<typeof createExtensionHost>;
function dimStatus(text: string): string { return `<dim>${text}</dim>`; }
function readStatusText(host: Host): string | undefined {
  const call = host.session.statusCalls.at(-1);
  assert.ok(call);
  assert.equal(call.key, "task-status");
  return call.text;
}
const restoredState = {
  version: 1, taskId: "task-1", taskName: "保留任务", status: "in_progress", phase: "验证", progressPercent: 20,
  updatesUsed: 2, lastTransitionGeneration: 0, waitingEscapeUsed: false, blockedEscapeUsed: false,
};
function stateEntry(data: unknown): Entry { return { type: "custom", customType: "task-status-state", data }; }
function reviewEntry(): Entry { return { type: "custom", customType: "task-efficiency:source", data: {} }; }
function assertNoNameAccess(host: Host) {
  assert.equal(host.nameReads(), 0);
  assert.deepEqual(host.nameWrites, []);
  assert.equal(host.session.entriesReads(), 0);
}

test("session_start 只恢复，接受工具更新才首次命名并独立保存归属", async () => {
  const host = createExtensionHost();
  await host.emit("session_start", { reason: "startup" });
  assert.equal(readStatusText(host), dimStatus("正在识别任务"));
  assertNoNameAccess(host);
  const result = await host.execute({ taskTransition: "new" });
  assert.equal(result.isError, undefined);
  assert.equal((result.details as { maxUpdatesPerTask: number }).maxUpdatesPerTask, 20);
  assert.match(result.content[0].text!, /1\/20 次更新/);
  assert.equal(readStatusText(host), dimStatus("修复扩展 · 进行中（实现，10%）"));
  assert.equal(host.entries.length, 2);
  const state = host.entries[0].data as Record<string, unknown>;
  assert.equal(host.entries[0].customType, "task-status-state");
  assert.equal(state.taskName, "修复扩展");
  assert.equal(state.version, 1);
  assert.equal("lastTitle" in state, false);
  assert.equal("sessionInfoId" in state, false);
  const info = host.session.allEntries.find((entry) => entry.type === "session_info");
  assert.ok(info);
  assert.equal(host.entries[1].customType, SESSION_NAME_OWNER_TYPE);
  assert.deepEqual(host.entries[1].data, { version: 1, sessionInfoId: info.id, name: "修复扩展" });
  assert.deepEqual(host.nameWrites, ["修复扩展"]);
});

test("同名、状态或进度更新不写名称；continue 修正与换主要任务跟随", async () => {
  const host = createExtensionHost();
  await host.execute();
  const unchanged = await host.execute();
  assert.equal((unchanged.details as { changed: boolean }).changed, false);
  assert.equal(host.entries.length, 2);
  await host.execute({ progressPercent: 20 });
  await host.execute({ status: "waiting_for_user", progressPercent: 20 });
  assert.deepEqual(host.nameWrites, ["修复扩展"]);
  await host.execute({ taskName: "修正任务" });
  await host.emit("message_start", { message: { role: "user" } });
  const next = await host.execute({ taskTransition: "new", taskName: "新主要任务" });
  assert.equal(next.isError, undefined);
  assert.deepEqual(host.nameWrites, ["修复扩展", "修正任务", "新主要任务"]);
  assert.equal(host.session.allEntries.filter((entry) => entry.type === "session_info").length, 3);
});

test("名称使用已规范化的 taskName，无 UI 同样命名", async () => {
  const host = createExtensionHost([], false);
  const result = await host.execute({ taskName: `  修复\n扩展 ${"长".repeat(50)} ` });
  assert.equal(result.isError, undefined);
  const state = host.entries[0].data as typeof restoredState;
  assert.equal(host.nameWrites[0], state.taskName);
  assert.equal(Array.from(state.taskName).length, 36);
  assert.equal(state.taskName.includes("\n"), false);
  assert.equal(host.session.statusCalls.length, 0);
});

for (const name of ["手动任务", "修复扩展", ""]) {
  test(`自动命名后手动改成 ${JSON.stringify(name)} 优先，branch 回退不丢保护`, async () => {
    const host = createExtensionHost();
    await host.execute();
    const autoBranch = [...host.session.allEntries];
    host.manualName(name);
    host.session.setBranch(autoBranch);
    const reads = host.nameReads();
    await host.emit("session_tree");
    assert.equal(host.nameReads(), reads, "切 branch 不读取名称");
    assert.deepEqual(host.nameWrites, ["修复扩展"]);
    await host.execute({ taskName: "后续主要任务" });
    assert.deepEqual(host.nameWrites, ["修复扩展"]);
  });
}

for (const name of ["已有名称", ""]) {
  test(`已有原生名称记录 ${JSON.stringify(name)} 不被首次更新覆盖`, async () => {
    const host = createExtensionHost([{ type: "session_info", id: "old", name }]);
    await host.execute();
    assert.deepEqual(host.nameWrites, []);
    assert.equal(host.entries.length, 1);
  });
}

test("恢复与 reload 只恢复任务；全会话自动归属跨 branch 延续", async () => {
  const host = createExtensionHost();
  await host.execute();
  const persisted = [...host.session.allEntries];
  const restored = createExtensionHost(persisted);
  await restored.emit("session_start", { reason: "resume" });
  assertNoNameAccess(restored);
  assert.equal(readStatusText(restored), dimStatus("修复扩展 · 进行中（实现，10%）"));
  extensionFactory(restored.api);
  await restored.emit("session_start", { reason: "reload" });
  assertNoNameAccess(restored);
  // 名称与 marker 不在当前 branch，但仍属于全会话。
  restored.session.setBranch([stateEntry(restoredState)]);
  await restored.emit("session_tree");
  assertNoNameAccess(restored);
  await restored.execute({ taskName: "保留任务" });
  assert.deepEqual(restored.nameWrites, ["保留任务"]);
});

test("review branch 停用工具且不读写名称，切回后恢复", async () => {
  const host = createExtensionHost([stateEntry(restoredState)]);
  await host.emit("session_start");
  assert.equal(readStatusText(host), dimStatus("保留任务 · 进行中（验证，20%）"));
  host.session.setBranch([stateEntry(restoredState), reviewEntry()]);
  await host.emit("session_tree");
  assert.equal(readStatusText(host), undefined);
  assert.equal(host.activeTools().includes("update_task_status"), false);
  assert.equal((await host.execute()).isError, true);
  assert.equal(await host.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions: { sections: {}, selectedTools: host.activeTools() } }), undefined);
  assertNoNameAccess(host);
  host.session.setBranch([stateEntry(restoredState)]);
  await host.emit("session_tree");
  assert.equal(host.activeTools().includes("update_task_status"), true);
  assert.equal(readStatusText(host), dimStatus("保留任务 · 进行中（验证，20%）"));
  assertNoNameAccess(host);
});

test("首次进入 review 与未初始化 prompt 检测均不访问名称", async () => {
  for (const event of ["session_start", "before_agent_start"]) {
    const host = createExtensionHost([reviewEntry()]);
    await host.emit(event, { systemPrompt: "base", systemPromptOptions: { sections: {}, selectedTools: host.activeTools() } });
    assert.equal((await host.execute()).isError, true);
    assertNoNameAccess(host);
  }
});

test("非法、超限、同一用户消息二次 new 均不改名", async () => {
  const host = createExtensionHost([stateEntry({ ...restoredState, updatesUsed: 20 })]);
  for (const overrides of [
    { taskName: "" }, { progressPercent: 15 }, { status: "completed", progressPercent: 90 },
    { taskName: "超限任务" }, { taskTransition: "new", taskName: "错误切换" },
  ]) {
    assert.equal((await host.execute(overrides)).isError, true);
  }
  assertNoNameAccess(host);
  assert.deepEqual(host.entries, []);
});

test("首次状态保存失败不刷新或命名，重试仍保存且只计一次", async () => {
  const host = createExtensionHost();
  await host.emit("session_start");
  const statusCount = host.session.statusCalls.length;
  host.failAt("state");
  const failed = await host.execute();
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text!, /state 写入失败/);
  assert.equal(host.session.statusCalls.length, statusCount);
  assert.equal(host.entries.length, 0);
  assert.equal(host.session.allEntries.length, 0);
  assertNoNameAccess(host);

  host.failAt(undefined);
  const retried = await host.execute();
  assert.equal(retried.isError, undefined);
  assert.deepEqual({
    changed: (retried.details as { changed: boolean }).changed,
    createdTask: (retried.details as { createdTask: boolean }).createdTask,
    updatesUsed: (retried.details as { updatesUsed: number }).updatesUsed,
  }, { changed: true, createdTask: true, updatesUsed: 1 });
  assert.equal(host.entries.filter((entry) => entry.customType === "task-status-state").length, 1);
  assert.deepEqual(host.nameWrites, ["修复扩展"]);
  assert.equal(readStatusText(host), dimStatus("修复扩展 · 进行中（实现，10%）"));
  const repeated = await host.execute();
  assert.equal((repeated.details as { changed: boolean }).changed, false);
  assert.equal((repeated.details as { updatesUsed: number }).updatesUsed, 1);
  assert.equal(host.entries.filter((entry) => entry.customType === "task-status-state").length, 1);
});

test("已有任务状态保存失败保留原任务、计数、展示和名称，重试不丢更新", async () => {
  const host = createExtensionHost();
  await host.execute();
  const savedState = host.entries[0].data as typeof restoredState;
  const entriesBefore = [...host.session.allEntries];
  const statusCount = host.session.statusCalls.length;
  const reads = host.session.entriesReads();
  const nameReads = host.nameReads();
  const input = { taskName: "保存后再改名", progressPercent: 20 };
  host.failAt("state");
  const failed = await host.execute(input);
  assert.equal(failed.isError, true);
  assert.deepEqual(host.session.allEntries, entriesBefore);
  assert.equal(host.session.statusCalls.length, statusCount);
  assert.equal(host.session.entriesReads(), reads);
  assert.equal(host.nameReads(), nameReads);
  assert.deepEqual(host.nameWrites, ["修复扩展"]);

  host.failAt(undefined);
  const retried = await host.execute(input);
  assert.equal(retried.isError, undefined);
  assert.equal((retried.details as { changed: boolean }).changed, true);
  assert.equal((retried.details as { createdTask: boolean }).createdTask, false);
  assert.equal((retried.details as { updatesUsed: number }).updatesUsed, 2);
  const states = host.entries.filter((entry) => entry.customType === "task-status-state");
  assert.equal(states.length, 2);
  assert.equal((states[1].data as typeof restoredState).taskId, savedState.taskId);
  assert.equal((states[1].data as typeof restoredState).updatesUsed, 2);
  assert.deepEqual(host.nameWrites, ["修复扩展", "保存后再改名"]);
  assert.equal(readStatusText(host), dimStatus("保存后再改名 · 进行中（实现，20%）"));
});

for (const failure of ["get", "set", "marker", "missing-info", "race"] as const) {
  test(`名称 ${failure} 失败返回明确警告，已持久化状态仍成功且可继续`, async () => {
    const host = createExtensionHost();
    host.failAt(failure);
    const result = await host.execute();
    assert.equal(result.isError, undefined);
    const text = result.content[0].text!;
    assert.match(text.split("\n")[0], /警告：会话名称未同步/);
    const collapsed = formatTaskStatusResult(text, false, Boolean(result.isError), "展开详情");
    assert.equal(collapsed.length, 1);
    assert.match(collapsed[0], /警告：会话名称未同步/);
    assert.match(text.split("\n")[2], /警告：会话名称更新失败，任务状态已保留：/);
    assert.ok((result.details as { sessionNameWarning?: string }).sessionNameWarning);
    assert.equal(host.entries[0].customType, "task-status-state");
    assert.equal((host.entries[0].data as typeof restoredState).updatesUsed, 1);
    assert.equal(readStatusText(host), dimStatus("修复扩展 · 进行中（实现，10%）"));
    assert.equal(host.entries.some((entry) => entry.customType === SESSION_NAME_OWNER_TYPE), false);
    host.failAt(undefined);
    const next = await host.execute({ taskName: "继续任务", progressPercent: 20 });
    assert.equal(next.isError, undefined);
    assert.doesNotMatch(next.content[0].text!, /警告/);
    assert.equal((next.details as { sessionNameWarning?: string }).sessionNameWarning, undefined);
    assert.equal((next.details as { updatesUsed: number }).updatesUsed, 2);
    if (failure === "marker" || failure === "race") assert.deepEqual(host.nameWrites, ["修复扩展"]);
  });
}

test("session_shutdown 清除 footer，不访问会话名称", async () => {
  const host = createExtensionHost();
  await host.emit("session_start");
  await host.emit("session_shutdown");
  assert.equal(readStatusText(host), undefined);
  assertNoNameAccess(host);
});
