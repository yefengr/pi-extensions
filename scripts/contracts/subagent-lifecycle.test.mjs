import assert from "node:assert/strict";
import test from "node:test";

import { buildLifecycleRecord } from "../../packages/pi-subagents/src/lifecycle/lifecycle-record.ts";
import {
  buildScopeProjection,
  buildSessionProjection,
  buildTaskEfficiencyReport,
  loadSourceSnapshot,
  validateTaskRange,
} from "../../packages/pi-task-efficiency/src/core/index.ts";
import { parseLifecycleRecord } from "../../packages/pi-task-efficiency/src/core/lifecycle.ts";
import {
  assistant,
  BASE_TIME,
  entry,
  header,
  message,
  usage,
  user,
  writeSession,
} from "../../packages/pi-task-efficiency/tests/fixtures.ts";

const PRIVATE_TEXT = "PRIVATE_CONTRACT_TEXT";
const ZERO_USAGE = { input: 0, output: 0, cacheWrite: 0 };
const INVOCATION_USAGE = { input: 10, output: 3, cacheWrite: 1 };
const OUTCOMES = ["completed", "turn_limit", "timeout", "queue_timeout", "cancelled", "error"];

// 调用真实生产函数；只提供其读取的被动视图，不创建会执行模型请求的子会话。
function producedRecord(overrides = {}) {
  const view = {
    id: "contract-agent",
    type: "contract-test",
    description: PRIVATE_TEXT,
    phase: "terminal",
    outcome: "completed",
    isBackground: false,
    lifecycleInvocation: { kind: "fresh", source: "tool" },
    invocationIndex: 1,
    toolCallId: "spawn",
    sessionState: "created",
    sessionId: "child-session",
    invocationStartedAt: BASE_TIME + 1000,
    completedAt: BASE_TIME + 4000,
    invocationTurnCount: 1,
    lifetimeTurnCount: 1,
    maxTurns: 30,
    wrapUpTurns: 2,
    maxDurationSeconds: 1800,
    result: PRIVATE_TEXT,
    error: PRIVATE_TEXT,
    invocationToolUses: 0,
    toolUses: 0,
    invocationUsage: INVOCATION_USAGE,
    lifetimeUsage: INVOCATION_USAGE,
    ...overrides,
  };
  // 模拟 appendEntry 后落盘再读取，避免只验证内存对象。
  return JSON.parse(JSON.stringify(buildLifecycleRecord(view)));
}

function parentCall(id, parentId, seconds, resume) {
  return message(id, parentId, seconds, "assistant", {
    content: [{ type: "toolCall", id, name: "subagent", arguments: resume ? { resume } : { subagent_type: "contract-test" } }],
    provider: "test-provider",
    model: "test-model",
    api: "test-api",
    usage: usage(),
    stopReason: "toolUse",
  });
}

function callResult(id, parentId, seconds, toolCallId) {
  return message(id, parentId, seconds, "toolResult", {
    toolCallId,
    toolName: "subagent",
    content: "done",
    isError: false,
  });
}

function parentEntries(records) {
  const values = [header(3, { id: "parent" }), user("u1", null, 0)];
  let parentId = "u1";
  for (const [index, record] of records.entries()) {
    const start = index * 4 + 1;
    const callId = record.toolCallId;
    values.push(parentCall(callId, parentId, start, index ? record.id : undefined));
    values.push(callResult(`${callId}-result`, callId, start + 1, callId));
    parentId = `${callId}-record`;
    values.push(entry("custom", parentId, `${callId}-result`, start + 3, { customType: "subagents:record", data: record }));
  }
  values.push(assistant("done", parentId, records.length * 4 + 1));
  return values;
}

async function snapshot(t, values) {
  return loadSourceSnapshot(await writeSession(t, values));
}

async function reportFor(t, records, dependencies) {
  const source = await snapshot(t, parentEntries(records));
  const range = validateTaskRange(source, { startEntryId: "u1", endEntryId: "done" });
  return buildTaskEfficiencyReport(source, range, dependencies);
}

for (const outcome of OUTCOMES) {
  test(`真实 producer → consumer：v3 ${outcome} 可解析、投影且不泄露正文`, async (t) => {
    const record = producedRecord({ outcome });
    const parsed = parseLifecycleRecord(record);
    assert.equal(record.recordVersion, 3);
    assert.equal(parsed.unsupported, false);
    assert.equal(parsed.record?.status, outcome);
    const projection = buildSessionProjection(await snapshot(t, parentEntries([record])));
    const projected = projection.entries.find((item) => item.kind === "subagent");
    assert.equal(projected?.record.recordVersion, 3);
    assert.equal(projected?.record.status, outcome);
    const compact = buildScopeProjection(projection).entries.find((item) => item.kind === "subagent");
    assert.equal(compact?.status, outcome);
    const serialized = JSON.stringify(projection);
    assert.equal(serialized.includes(PRIVATE_TEXT), false);
    assert.equal(serialized.includes("outputFile"), false);
  });
}

for (const outcome of ["error", "cancelled", "queue_timeout"]) {
  test(`真实 producer → report：${outcome} 无子会话时不发现或虚构 transcript`, async (t) => {
    const record = producedRecord({
      outcome,
      sessionState: "not-created",
      sessionId: undefined,
      stoppedWhileQueued: true,
      invocationTurnCount: 0,
      lifetimeTurnCount: 0,
      invocationUsage: ZERO_USAGE,
      lifetimeUsage: ZERO_USAGE,
    });
    assert.notEqual(parseLifecycleRecord(record).record, null);
    const report = await reportFor(t, [record], {
      readChildDirectory: async () => { assert.fail("不应发现无会话的 child"); },
    });
    assert.equal(report.subagents?.notCreated, 1);
    assert.equal(report.subagents?.sessions, 0);
    assert.equal(report.coverage.complete, true);
    assert.deepEqual(report.subagents.issues, []);
  });
}

test("真实 producer → report：fresh/resume 按同一 sessionId 的各自窗口聚合", async (t) => {
  const childPath = await writeSession(t, [
    header(3, { id: "child-session", parentSession: "parent" }),
    user("cu1", null, 2),
    assistant("ca1", "cu1", 3),
    user("cu2", "ca1", 6),
    assistant("ca2", "cu2", 7),
  ]);
  const fresh = producedRecord({ outputFile: childPath });
  const resume = producedRecord({
    outputFile: childPath,
    lifecycleInvocation: { kind: "resume", source: "tool" },
    invocationIndex: 2,
    toolCallId: "resume",
    invocationStartedAt: BASE_TIME + 5000,
    completedAt: BASE_TIME + 8000,
    lifetimeTurnCount: 2,
    lifetimeUsage: { input: 20, output: 6, cacheWrite: 2 },
  });
  const report = await reportFor(t, [fresh, resume], {
    readChildDirectory: async () => [childPath],
    loadChildSnapshot: loadSourceSnapshot,
  });
  assert.equal(report.coverage.complete, true);
  assert.equal(report.subagents?.invocations, 2);
  assert.equal(report.subagents?.sessions, 1);
  assert.equal(report.subagents?.fresh, 1);
  assert.equal(report.subagents?.resumes, 1);
  assert.equal(report.usage.children?.tokens.input, 20);
  assert.equal(report.usage.children?.cost.total, 0.4);
  assert.equal(JSON.stringify(report).includes(childPath), false);
});

test("未来 producer 版本仍拒绝，不能因当前版本兼容而放松验证", async (t) => {
  const record = { ...producedRecord(), recordVersion: 4 };
  assert.deepEqual(parseLifecycleRecord(record), { record: null, unsupported: true });
  const projection = buildSessionProjection(await snapshot(t, parentEntries([record])));
  assert.equal(projection.entries.some((item) => item.kind === "subagent"), false);
  const report = await reportFor(t, [record], {});
  assert.equal(report.coverage.complete, false);
  assert.ok(report.subagents.issues.some((issue) => issue.code === "unsupported_lifecycle_version"));
});
