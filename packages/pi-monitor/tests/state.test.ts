import assert from "node:assert/strict";
import test from "node:test";
import { MAX_RECENT_TASKS, NOTIFICATION_TYPE, RESULT_TYPE, STATE_TYPE } from "../src/constants.ts";
import { buildDelivery, formatStatus, formatTaskLines, safeText } from "../src/presentation.ts";
import { historicalRecord, restoreRecords } from "../src/state.ts";
import type { MonitorRecord } from "../src/types.ts";
import { definition } from "./helpers.ts";

function record(): MonitorRecord {
  const batch = { id: "batch-1", taskId: "task-1", checkedAt: Date.now(), events: [{ id: "event-1", summary: "完成" }] };
  return { ...definition(), status: "running", nextCheckAt: Date.now(), failures: 0, seenIds: ["event-1"], pending: [batch], lastResult: batch };
}
const saved = (task: MonitorRecord) => ({ type: "custom", customType: STATE_TYPE, data: { version: 1, record: task } });
const receipt = { ownerSessionId: "owner-1", deliveries: [{ taskId: "task-1", batchIds: ["batch-1"] }] };

test("restore selects latest snapshot, ignores forks and invalid records", () => {
  const task = record();
  const restored = restoreRecords([saved(task), saved({ ...task, failures: 2 }), saved({ ...task, ownerSessionId: "other" }), saved({ ...task, intervalMs: -1 })], "owner-1");
  assert.equal(restored.length, 1);
  assert.equal(restored[0].failures, 2);
  restored[0].seenIds.push("mutate");
  assert.equal(task.seenIds.length, 1);
  assert.deepEqual(restoreRecords([saved(task)], "fork-owner"), []);
});

test("persisted receipts suppress redelivery even if ack snapshot was interrupted", () => {
  const task = record();
  const message = { type: "custom_message", customType: RESULT_TYPE, details: receipt };
  assert.equal(restoreRecords([saved(task), message], "owner-1")[0].pending.length, 0);
  assert.equal(restoreRecords([saved(task), { ...message, id: "unpersisted" }], "owner-1", new Set())[0].pending.length, 1);
  assert.equal(restoreRecords([saved(task), { type: "custom", customType: NOTIFICATION_TYPE, data: { receipt } }], "owner-1")[0].pending.length, 0);
  assert.equal(restoreRecords([saved(task), { ...message, details: { ...receipt, ownerSessionId: "wrong" } }], "owner-1")[0].pending.length, 1);
});

test("旧状态缺少 logLevel 或级别非法时均不恢复", () => {
  const task = record();
  const legacy: any = { ...task };
  delete legacy.logLevel;
  assert.deepEqual(restoreRecords([saved(legacy)], "owner-1"), []);
  assert.equal(historicalRecord([saved(legacy)], "owner-1", task.id), undefined);
  assert.equal(restoreRecords([saved({ ...task, logLevel: "bad" as any })], "owner-1").length, 0);
  for (const logLevel of ["off", "info", "debug"] as const) {
    assert.equal(restoreRecords([saved({ ...task, logLevel })], "owner-1")[0].logLevel, logLevel);
  }
});

test("restore bounds retired cache without losing active, pending or historical evidence", () => {
  const task = record();
  const entries = Array.from({ length: MAX_RECENT_TASKS + 8 }, (_, n) => saved({ ...task, id: `old-${n}`, status: "completed", pending: [], lastResult: undefined }));
  entries.unshift(saved({ ...task, status: "completed" })); // 有 pending 的终态不能淘汰。
  const restored = restoreRecords(entries, "owner-1");
  assert.equal(restored.length, MAX_RECENT_TASKS + 1);
  assert.equal(restored.find((item) => item.id === "task-1")?.pending.length, 1);
  assert.ok(!restored.some((item) => item.id === "old-0"));
  assert.equal(historicalRecord(entries, "owner-1", "old-0")?.status, "completed");
  assert.equal(historicalRecord(entries, "foreign", "old-0"), undefined);
});

test("message limit selects whole batches without acknowledging omitted results", () => {
  const task = record();
  task.pending = Array.from({ length: 8 }, (_, batch) => ({ id: `batch-${batch}`, taskId: task.id, checkedAt: Date.now(), events: Array.from({ length: 32 }, (_, n) => ({ id: `${batch}-${n}-` + "x".repeat(240), summary: "s".repeat(500), data: "d".repeat(1_000) })) }));
  const { content, receipt } = buildDelivery([task], "owner-1");
  assert.ok(content.length <= 32_000);
  assert.ok(receipt.deliveries[0].batchIds.length > 0);
  assert.ok(receipt.deliveries[0].batchIds.length < task.pending.length);
  assert.equal(task.pending.length, 8);
  assert.ok(content.includes("batch-0"));
});

test("task list hides finished tasks unless all is requested", () => {
  const running = { ...record(), pending: [], lastResult: undefined };
  const done = { ...record(), id: "task-2", status: "completed" as const, pending: [], lastResult: undefined };
  const activeView = formatTaskLines([running, done]);
  assert.match(activeView, /运行/);
  assert.doesNotMatch(activeView, /已完成/);
  assert.match(activeView, /另有 1 个已结束/);
  assert.match(formatTaskLines([running, done], { all: true }), /已完成/);
  assert.equal(formatTaskLines([done]), "当前没有活动监听；另有 1 个已结束（list all 查看）");
});

test("footer counts tasks, separates retry subset and pending terminal tasks", () => {
  const task = record();
  assert.equal(formatStatus([]), undefined);
  assert.equal(formatStatus([{ ...task, pending: [], status: "stopped" }]), undefined);
  assert.equal(formatStatus([task, { ...task, id: "task-2", status: "paused" }, { ...task, id: "task-3", failures: 1, pending: [] }]), "监听 暂停 1 · 待回传 2 · 运行 2 · 重试 1");
  assert.equal(formatStatus([{ ...task, status: "completed" }]), "监听 待回传 1");
  assert.doesNotMatch(safeText("\x1b]777;notify;test\x07\u202e"), /[\x1b\x07\u202e]/);
});
