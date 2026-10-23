import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTaskEfficiencyReport,
  loadSourceSnapshot,
  validateTaskRange,
} from "../core/index.ts";
import { assistant, entry, header, message, usage, user, writeSession } from "./fixtures.ts";

function assistantMessage(
  id: string,
  parentId: string,
  seconds: number,
  stopReason: string,
  content: unknown[] = [{ type: "text", text: "assistant" }],
  metric: unknown = usage(),
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    content,
    provider: "test-provider",
    model: "test-model",
    api: "test-api",
    stopReason,
  };
  if (metric !== undefined) fields.usage = metric;
  return message(id, parentId, seconds, "assistant", fields);
}

function result(
  id: string,
  parentId: string,
  seconds: number,
  toolCallId: string,
  isError = false,
  metric?: unknown,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    toolCallId,
    toolName: "read",
    content: "tool",
    isError,
  };
  if (metric !== undefined) fields.usage = metric;
  return message(id, parentId, seconds, "toolResult", fields);
}

async function reportFor(t: Parameters<typeof writeSession>[0], values: readonly unknown[], start: string, end: string) {
  const snapshot = await loadSourceSnapshot(await writeSession(t, values));
  return buildTaskEfficiencyReport(snapshot, validateTaskRange(snapshot, { startEntryId: start, endEntryId: end }));
}

test("时间、并行工具关键路径、summary usage 与稳定报告 DTO", async (t) => {
  const report = await reportFor(t, [
    header(),
    user("u1", null, 0),
    assistantMessage("call", "u1", 1, "toolUse", [
      { type: "toolCall", id: "call-1", name: "read", arguments: {} },
      { type: "toolCall", id: "call-2", name: "read", arguments: {} },
    ]),
    result("r1", "call", 3, "call-1", false, usage()),
    result("r2", "r1", 5, "call-2"),
    entry("compaction", "compact", "r2", 5.5, {
      summary: "summary",
      firstKeptEntryId: "u1",
      tokensBefore: 1,
      usage: usage(),
    }),
    assistantMessage("a1", "compact", 6, "stop"),
    user("u2", "a1", 10),
    assistant("a2", "u2", 12),
  ], "u1", "a2");

  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.time, {
    wallClockSpanSeconds: 12,
    userWaitSeconds: 4,
    agentActiveSeconds: 8,
    toolCriticalPathSeconds: 4,
    nonToolActiveSeconds: 4,
  });
  assert.deepEqual(report.tools, {
    calls: 2,
    batches: 1,
    failures: 0,
    incompleteCalls: 0,
    orphanResults: 0,
    byTool: { read: { calls: 2, failures: 0, incompleteCalls: 0 } },
    batchWaitSeconds: 4,
    criticalPathSeconds: 4,
    longestCallSeconds: 4,
  });
  assert.equal(report.usage.parent.events, 5);
  assert.equal(report.usage.parent.tokens.input, 50);
  assert.equal(report.usage.parent.byModel["tools/summaries"].events, 2);
  assert.equal(report.usage.parent.tokens.reasoning, null);
  assert.equal(report.coverage.reasoningComplete, false);
  assert.equal(report.coverage.complete, true);
  assert.equal(report.subagents, null);
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.usage.parent.byModel));
});

test("工具等待使用 assistant 完成落盘时间而非请求开始时间", async (t) => {
  const call = assistantMessage("call", "u1", 3, "toolUse", [
    { type: "toolCall", id: "call-1", name: "read", arguments: {} },
  ]) as Record<string, any>;
  call.message.timestamp = Date.parse("2026-09-07T00:00:00.010Z");
  const tool = result("r1", "call", 5.001, "call-1") as Record<string, any>;
  tool.message.timestamp = Date.parse("2026-09-07T00:00:00.012Z");
  const report = await reportFor(t, [
    header(),
    user("u1", null, 0),
    call,
    tool,
    assistantMessage("a1", "r1", 7, "stop"),
  ], "u1", "a1");

  assert.equal(report.tools.batchWaitSeconds, 2.001);
  assert.equal(report.tools.criticalPathSeconds, 2.001);
  assert.equal(report.tools.longestCallSeconds, 2.001);
});

test("缺失或部分 usage/cost 保留快照并关闭 coverage，reasoning 不重复", async (t) => {
  const completeWithReasoning = {
    ...usage(),
    reasoning: 2,
  };
  const partial = { input: 10, output: 3 };
  const report = await reportFor(t, [
    header(),
    user("u1", null, 0),
    assistantMessage("a1", "u1", 1, "stop", [{ type: "text", text: "assistant" }], completeWithReasoning),
    user("u2", "a1", 2),
    assistantMessage("a2", "u2", 3, "stop", [{ type: "text", text: "assistant" }], partial),
  ], "u1", "a2");

  assert.equal(report.usage.parent.events, 2);
  assert.deepEqual(report.usage.parent.tokens, {
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    reasoning: null,
    totalTokens: null,
  });
  assert.equal(report.usage.parent.cost.total, null);
  assert.equal(report.coverage.usageComplete, false);
  assert.equal(report.coverage.costComplete, false);
  assert.equal(report.coverage.complete, false);

  const projected = JSON.stringify(report);
  assert.equal(projected.includes("reasoning\":2"), false);
});

test("缺少、重复和倒序工具结果关闭 timing，但保留调用与失败计数", async (t) => {
  const report = await reportFor(t, [
    header(),
    user("u1", null, 0),
    assistantMessage("call", "u1", 10, "toolUse", [
      { type: "toolCall", id: "missing", name: "read", arguments: {} },
      { type: "toolCall", id: "duplicate", name: "read", arguments: {} },
      { type: "toolCall", id: "reverse", name: "read", arguments: {} },
    ]),
    result("r1", "call", 11, "duplicate"),
    result("r2", "r1", 12, "duplicate", true),
    result("r3", "r2", 9, "reverse", true),
    assistant("done", "r3", 13),
  ], "u1", "done");

  assert.equal(report.tools.calls, 3);
  assert.equal(report.tools.incompleteCalls, 2);
  assert.equal(report.tools.orphanResults, 2);
  assert.equal(report.tools.failures, 1);
  assert.equal(report.tools.batchWaitSeconds, null);
  assert.equal(report.tools.criticalPathSeconds, null);
  assert.equal(report.time.toolCriticalPathSeconds, null);
  assert.equal(report.time.nonToolActiveSeconds, null);
  assert.equal(report.coverage.toolTimingComplete, false);
});

test("模型错误、自动重试、恢复和最终失败按 turn 统计", async (t) => {
  const report = await reportFor(t, [
    header(),
    user("u1", null, 0),
    assistantMessage("failed", "u1", 1, "error"),
    assistantMessage("recovered", "failed", 2, "stop"),
    user("u2", "recovered", 3),
    assistantMessage("terminal", "u2", 4, "error"),
  ], "u1", "terminal");

  assert.deepEqual(report.modelEvents, {
    responses: 3,
    failures: 2,
    automaticRetries: 1,
    turnsWithFailures: 2,
    recoveredTurns: 1,
    failedTurns: 1,
    statuses: { completed: 1, toolUse: 0, failed: 2, truncated: 0, aborted: 0, other: 0 },
    byModel: {
      "test-provider:test-model": {
        responses: 3,
        failures: 2,
        automaticRetries: 1,
        statuses: { completed: 1, toolUse: 0, failed: 2, truncated: 0, aborted: 0, other: 0 },
      },
    },
  });
});

test("仅 orphan result 关闭工具 timing，不把未知结果当作零", async (t) => {
  const report = await reportFor(t, [
    header(),
    user("u1", null, 0),
    assistantMessage("first", "u1", 1, "toolUse"),
    result("orphan", "first", 2, "unmatched", true),
    assistantMessage("done", "orphan", 3, "stop"),
  ], "u1", "done");

  assert.deepEqual(report.tools, {
    calls: 0,
    batches: 0,
    failures: 0,
    incompleteCalls: 0,
    orphanResults: 1,
    byTool: {},
    batchWaitSeconds: null,
    criticalPathSeconds: null,
    longestCallSeconds: null,
  });
  assert.equal(report.coverage.toolTimingComplete, false);
});

test("重复 call 加单个 error result 不从歧义配对推导失败", async (t) => {
  const report = await reportFor(t, [
    header(),
    user("u1", null, 0),
    assistantMessage("calls", "u1", 1, "toolUse", [
      { type: "toolCall", id: "duplicate", name: "read", arguments: {} },
      { type: "toolCall", id: "duplicate", name: "read", arguments: {} },
    ]),
    result("error", "calls", 2, "duplicate", true),
    assistantMessage("done", "error", 3, "stop"),
  ], "u1", "done");

  assert.deepEqual(report.tools, {
    calls: 2,
    batches: 1,
    failures: 0,
    incompleteCalls: 2,
    orphanResults: 1,
    byTool: { read: { calls: 2, failures: 0, incompleteCalls: 2 } },
    batchWaitSeconds: null,
    criticalPathSeconds: null,
    longestCallSeconds: null,
  });
  assert.equal(report.coverage.toolTimingComplete, false);
});
