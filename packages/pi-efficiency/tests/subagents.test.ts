import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTaskEfficiencyReport,
  loadSourceSnapshot,
  validateTaskRange,
} from "../core/index.ts";
import {
  assistant,
  BASE_TIME,
  entry,
  header,
  lifecycleRecord,
  message,
  usage,
  user,
  writeSession,
} from "./fixtures.ts";

const INVOCATION_USAGE = { input: 10, output: 3, cacheWrite: 1, total: 14 };

function parentAssistant(
  id: string,
  parentId: string,
  seconds: number,
  stopReason: string,
  calls: readonly { id: string; resume?: string }[] = [],
): Record<string, unknown> {
  return message(id, parentId, seconds, "assistant", {
    content: calls.length === 0
      ? [{ type: "text", text: "assistant" }]
      : calls.map((call) => ({
        type: "toolCall",
        id: call.id,
        name: "subagent",
        arguments: call.resume === undefined ? { subagent_type: "deepseek-flash-standard-worker" } : { resume: call.resume },
      })),
    provider: "test-provider",
    model: "test-model",
    api: "test-api",
    usage: usage(),
    stopReason,
  });
}

function parentResult(id: string, parentId: string, seconds: number, toolCallId: string): Record<string, unknown> {
  return message(id, parentId, seconds, "toolResult", {
    toolCallId,
    toolName: "subagent",
    content: "result",
    isError: false,
  });
}

function lifecycle(
  toolCallId: string,
  childPath: string | undefined,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return lifecycleRecord({
    toolCallId,
    outputFile: childPath,
    startedAt: BASE_TIME + 1000,
    completedAt: BASE_TIME + 4000,
    durationMs: 3000,
    invocationToolUses: 0,
    invocationUsage: INVOCATION_USAGE,
    lifetimeToolUses: 0,
    lifetimeUsage: INVOCATION_USAGE,
    ...overrides,
  });
}

async function parentReport(
  t: Parameters<typeof writeSession>[0],
  values: readonly unknown[],
  start: string,
  end: string,
  paths: readonly string[] = [],
) {
  const parent = await loadSourceSnapshot(await writeSession(t, values));
  const range = validateTaskRange(parent, { startEntryId: start, endEntryId: end });
  return buildTaskEfficiencyReport(parent, range, {
    readChildDirectory: async () => paths,
    loadChildSnapshot: loadSourceSnapshot,
  });
}

async function completeChild(
  t: Parameters<typeof writeSession>[0],
  parentSession = "parent",
): Promise<string> {
  return writeSession(t, [
    header(3, { id: "child-session", parentSession }),
    user("cu1", null, 2),
    assistant("ca1", "cu1", 3),
  ]);
}

function completeParent(childPath: string | undefined, record = lifecycle("spawn", childPath)): readonly unknown[] {
  return [
    header(3, { id: "parent" }),
    user("u1", null, 0),
    parentAssistant("spawn", "u1", 1, "toolUse", [{ id: "spawn" }]),
    parentResult("spawn-result", "spawn", 2, "spawn"),
    entry("custom", "record", "spawn-result", 3, { customType: "subagents:record", data: record }),
    parentAssistant("done", "record", 4, "stop"),
  ];
}

test("完整直接 child 仅按 sessionId 聚合，且不泄露 outputFile", async (t) => {
  const childPath = await completeChild(t);
  const report = await parentReport(t, completeParent(childPath), "u1", "done", [childPath]);
  assert.ok(report.subagents);
  assert.equal(report.subagents.invocations, 1);
  assert.equal(report.subagents.sessions, 1);
  assert.equal(report.subagents.fresh, 1);
  assert.equal(report.subagents.resumes, 0);
  assert.equal(report.subagents.coverage.complete, true);
  assert.equal(report.subagents.usage.tokens.input, 10);
  assert.equal(report.subagents.usage.byModel["test-provider:test-model"].tokens.input, 10);
  const childCost = report.subagents.usage.byModel["test-provider:test-model"].cost.total;
  assert.notEqual(childCost, null);
  assert.equal(childCost, 0.2);
  assert.equal(report.usage.combined.tokens.input, 30);
  assert.equal(report.usage.combined.byModel["test-provider:test-model"].tokens.input, 30);
  const combinedCost = report.usage.combined.byModel["test-provider:test-model"].cost.total;
  assert.notEqual(combinedCost, null);
  assert.ok(Math.abs(combinedCost! - 0.6) < Number.EPSILON);
  assert.equal(report.coverage.toolTimingComplete, true);
  assert.equal(report.coverage.modelEventsComplete, true);
  assert.equal(report.coverage.complete, true);
  assert.notEqual(report.subagents.timeline.workflowCriticalPathSeconds, null);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(childPath), false);
  assert.equal(serialized.includes("outputFile"), false);
});

test("范围结束后写入的终态 record 仍可归属，其他任务 record 不污染", async (t) => {
  const childPath = await completeChild(t);
  const delayed = lifecycle("spawn", childPath);
  const unrelated = lifecycle("other-call", "/other/child.jsonl", {
    id: "other-agent",
    sessionId: "other-child",
    startedAt: BASE_TIME - 5000,
    completedAt: BASE_TIME - 1000,
    durationMs: 4000,
  });
  const spawn = parentAssistant("spawn", "u1", 1, "toolUse", [{ id: "spawn" }]) as Record<string, any>;
  spawn.message.content[0].arguments.run_in_background = true;
  const values = [
    header(3, { id: "parent" }),
    user("u1", null, 0),
    spawn,
    parentResult("spawn-result", "spawn", 2, "spawn"),
    parentAssistant("done", "spawn-result", 4, "stop"),
    entry("custom", "delayed-record", "done", 5, { customType: "subagents:record", data: delayed }),
    entry("custom", "unrelated-record", "delayed-record", 6, { customType: "subagents:record", data: unrelated }),
  ];
  const report = await parentReport(t, values, "u1", "done", [childPath]);

  assert.ok(report.subagents);
  assert.equal(report.subagents.invocations, 1);
  assert.equal(report.subagents.sessions, 1);
  assert.equal(report.subagents.coverage.complete, true);
  assert.equal(report.subagents.usage.tokens.input, 10);
  assert.equal(report.subagents.issues.length, 0);
});

test("fresh 与 resume 各自仅统计对应 child 窗口", async (t) => {
  const childPath = await writeSession(t, [
    header(3, { id: "child-session", parentSession: "parent" }),
    user("fresh-user", null, 2),
    assistant("fresh-assistant", "fresh-user", 3),
    user("resume-user", "fresh-assistant", 6),
    assistant("resume-assistant", "resume-user", 7),
  ]);
  const fresh = lifecycle("fresh-call", childPath, {
    startedAt: BASE_TIME + 1000,
    completedAt: BASE_TIME + 4000,
    durationMs: 3000,
  });
  const resume = lifecycle("resume-call", childPath, {
    invocationKind: "resume",
    invocationIndex: 2,
    startedAt: BASE_TIME + 6000,
    completedAt: BASE_TIME + 9000,
    durationMs: 3000,
  });
  const values = [
    header(3, { id: "parent" }),
    user("u1", null, 0),
    parentAssistant("fresh-call", "u1", 1, "toolUse", [{ id: "fresh-call" }]),
    parentResult("fresh-result", "fresh-call", 2, "fresh-call"),
    entry("custom", "fresh-record", "fresh-result", 3, { customType: "subagents:record", data: fresh }),
    parentAssistant("fresh-done", "fresh-record", 4, "stop"),
    user("u2", "fresh-done", 5),
    parentAssistant("resume-call", "u2", 6, "toolUse", [{ id: "resume-call", resume: "agent-1" }]),
    parentResult("resume-result", "resume-call", 7, "resume-call"),
    entry("custom", "resume-record", "resume-result", 8, { customType: "subagents:record", data: resume }),
    parentAssistant("resume-done", "resume-record", 9, "stop"),
  ];
  const parent = await loadSourceSnapshot(await writeSession(t, values));
  const dependencies = { readChildDirectory: async () => [childPath], loadChildSnapshot: loadSourceSnapshot };
  const freshReport = await buildTaskEfficiencyReport(parent, validateTaskRange(parent, { startEntryId: "u1", endEntryId: "fresh-done" }), dependencies);
  const resumeReport = await buildTaskEfficiencyReport(parent, validateTaskRange(parent, { startEntryId: "u2", endEntryId: "resume-done" }), dependencies);

  assert.ok(freshReport.subagents && resumeReport.subagents);
  assert.equal(freshReport.subagents.usage.tokens.input, 10);
  assert.equal(resumeReport.subagents.usage.tokens.input, 10);
  assert.equal(freshReport.subagents.fresh, 1);
  assert.equal(resumeReport.subagents.resumes, 1);
  assert.equal(freshReport.subagents.coverage.complete, true);
  assert.equal(resumeReport.subagents.coverage.complete, true);
});

test("child 窗口按 user 提交时间和 assistant 完成时间归属", async (t) => {
  const childUser = user("child-user", null, 2) as Record<string, any>;
  childUser.message.timestamp = BASE_TIME + 1100;
  const childAssistant = assistant("child-assistant", "child-user", 4) as Record<string, any>;
  childAssistant.message.timestamp = BASE_TIME + 1200;
  const childPath = await writeSession(t, [
    header(3, { id: "child-session", parentSession: "parent" }),
    childUser,
    childAssistant,
  ]);
  const record = lifecycle("spawn", childPath, {
    startedAt: BASE_TIME + 1500,
    completedAt: BASE_TIME + 4500,
    durationMs: 3000,
  });
  const report = await parentReport(t, [
    header(3, { id: "parent" }),
    user("u1", null, 0),
    parentAssistant("spawn", "u1", 1, "toolUse", [{ id: "spawn" }]),
    parentResult("spawn-result", "spawn", 2, "spawn"),
    entry("custom", "record", "spawn-result", 4.5, { customType: "subagents:record", data: record }),
    parentAssistant("done", "record", 5, "stop"),
  ], "u1", "done", [childPath]);

  assert.ok(report.subagents);
  assert.equal(report.subagents.coverage.complete, true);
  assert.equal(report.subagents.timeline.childActiveSeconds, 2.9);
  assert.equal(report.subagents.timeline.childWorkSeconds, 2.9);
  assert.equal(report.subagents.timeline.workflowCriticalPathSeconds, 5);
  assert.equal(report.subagents.timeline.waitDuringChildSeconds, 0.9);
});

test("not-created error/stopped invocation 不要求虚构 child transcript", async (t) => {
  const stopped = lifecycle("spawn", undefined, {
    status: "stopped",
    sessionState: "not-created",
    sessionId: undefined,
    outputFile: undefined,
    invocationUsage: { input: 0, output: 0, cacheWrite: 0, total: 0 },
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, total: 0 },
  });
  const report = await parentReport(t, completeParent(undefined, stopped), "u1", "done");
  assert.ok(report.subagents);
  assert.equal(report.subagents.notCreated, 1);
  assert.equal(report.subagents.sessions, 0);
  assert.equal(report.subagents.coverage.complete, true);
  assert.deepEqual(report.subagents.usage.byModel, {});
  assert.equal(report.usage.children?.tokens.input, 0);
  assert.equal(report.usage.combined.byModel["test-provider:test-model"].tokens.input, 20);
  assert.equal(report.usage.combined.byModel["test-provider:test-model"].cost.total, 0.4);
  assert.equal(report.coverage.toolTimingComplete, true);
  assert.equal(report.coverage.modelEventsComplete, true);
  assert.equal(report.coverage.complete, true);
  assert.deepEqual(report.subagents.tools, {
    calls: 0,
    batches: 0,
    failures: 0,
    incompleteCalls: 0,
    orphanResults: 0,
    byTool: {},
    batchWaitSeconds: 0,
    criticalPathSeconds: 0,
    longestCallSeconds: 0,
  });
  assert.deepEqual(report.subagents.modelEvents, {
    responses: 0,
    failures: 0,
    automaticRetries: 0,
    turnsWithFailures: 0,
    recoveredTurns: 0,
    failedTurns: 0,
    statuses: { completed: 0, toolUse: 0, failed: 0, truncated: 0, aborted: 0, other: 0 },
    byModel: {},
  });
});

test("缺失、错 parent、重复 sessionId 和 outputFile 冲突均不回退", async (t) => {
  const childPath = await completeChild(t);
  const wrongParentPath = await completeChild(t, "other-parent");
  const duplicatePath = await completeChild(t);
  const cases: readonly {
    name: string;
    record: Record<string, unknown>;
    paths: readonly string[];
    code: string;
  }[] = [
    { name: "missing", record: lifecycle("spawn", childPath), paths: [], code: "missing_child_session" },
    { name: "wrong-parent", record: lifecycle("spawn", wrongParentPath), paths: [wrongParentPath], code: "child_parent_mismatch" },
    { name: "duplicate", record: lifecycle("spawn", childPath), paths: [childPath, duplicatePath], code: "duplicate_child_session" },
    { name: "output-conflict", record: lifecycle("spawn", "/not/a/child.jsonl"), paths: [childPath], code: "output_file_conflict" },
  ];
  for (const candidate of cases) {
    const report = await parentReport(t, completeParent(candidate.record.outputFile as string | undefined, candidate.record), "u1", "done", candidate.paths);
    assert.ok(report.subagents, candidate.name);
    assert.equal(report.subagents.coverage.complete, false, candidate.name);
    assert.ok(report.subagents.issues.some((issue) => issue.code === candidate.code), candidate.name);
    assert.equal(report.subagents.usage.tokens.input, null, candidate.name);
    assert.equal(report.subagents.usage.cost.total, null, candidate.name);
    assert.equal(report.subagents.tools, null, candidate.name);
    assert.equal(report.subagents.modelEvents, null, candidate.name);
    assert.equal(report.usage.parent.tokens.input, 20, candidate.name);
    assert.equal(report.usage.combined.tokens.input, null, candidate.name);
    assert.equal(report.coverage.usageComplete, false, candidate.name);
    assert.equal(report.coverage.costComplete, false, candidate.name);
    assert.equal(report.coverage.reasoningComplete, false, candidate.name);
    assert.equal(report.coverage.toolTimingComplete, false, candidate.name);
    assert.equal(report.coverage.modelEventsComplete, false, candidate.name);
    assert.equal(report.coverage.complete, false, candidate.name);
  }
});

test("窗口重叠、未 settled child 与 invocation usage/tool-count 不一致关闭 coverage", async (t) => {
  const overlappingChild = await completeChild(t);
  const first = lifecycle("first", overlappingChild, { completedAt: BASE_TIME + 5000, durationMs: 4000 });
  const second = lifecycle("second", overlappingChild, {
    invocationKind: "resume",
    invocationIndex: 2,
    startedAt: BASE_TIME + 2000,
    completedAt: BASE_TIME + 6000,
    durationMs: 4000,
  });
  const overlapReport = await parentReport(t, [
    header(3, { id: "parent" }),
    user("u1", null, 0),
    parentAssistant("calls", "u1", 1, "toolUse", [{ id: "first" }, { id: "second", resume: "agent-1" }]),
    parentResult("first-result", "calls", 2, "first"),
    parentResult("second-result", "first-result", 2.5, "second"),
    entry("custom", "first-record", "second-result", 3, { customType: "subagents:record", data: first }),
    entry("custom", "second-record", "first-record", 3.5, { customType: "subagents:record", data: second }),
    parentAssistant("done", "second-record", 7, "stop"),
  ], "u1", "done", [overlappingChild]);
  assert.ok(overlapReport.subagents);
  assert.equal(overlapReport.subagents.coverage.childSessionsSettled, false);
  assert.ok(overlapReport.subagents.issues.some((issue) => issue.code === "overlapping_invocation_windows"));
  assert.ok(overlapReport.subagents.issues.some((issue) => issue.code === "multiply_owned_child_turn"));

  const incompleteChild = await writeSession(t, [
    header(3, { id: "child-session", parentSession: "parent" }),
    user("cu1", null, 2),
    parentAssistant("child-tool", "cu1", 3, "toolUse", [{ id: "child-call" }]),
  ]);
  const mismatch = lifecycle("spawn", incompleteChild, {
    invocationToolUses: 0,
    invocationUsage: { input: 0, output: 0, cacheWrite: 0, total: 0 },
    lifetimeToolUses: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, total: 0 },
  });
  const mismatchReport = await parentReport(t, completeParent(incompleteChild, mismatch), "u1", "done", [incompleteChild]);
  assert.ok(mismatchReport.subagents);
  assert.equal(mismatchReport.subagents.coverage.complete, false);
  for (const code of ["unsettled_child_turn", "invocation_usage_mismatch", "invocation_tool_count_mismatch"]) {
    assert.ok(mismatchReport.subagents.issues.some((issue) => issue.code === code), code);
  }
});

test("settled child 的 lifecycle 对账不一致仍保留 tools/modelEvents", async (t) => {
  const childPath = await completeChild(t);
  const record = lifecycle("spawn", childPath, {
    invocationToolUses: 1,
    invocationUsage: { input: 0, output: 0, cacheWrite: 0, total: 0 },
    lifetimeToolUses: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, total: 0 },
  });
  const report = await parentReport(t, completeParent(childPath, record), "u1", "done", [childPath]);

  assert.ok(report.subagents);
  for (const code of ["invocation_usage_mismatch", "invocation_tool_count_mismatch"]) {
    assert.ok(report.subagents.issues.some((issue) => issue.code === code), code);
  }
  assert.equal(report.subagents.coverage.usageComplete, false);
  assert.equal(report.subagents.coverage.costComplete, false);
  assert.equal(report.subagents.usage.tokens.input, null);
  assert.equal(report.subagents.usage.cost.total, null);
  assert.deepEqual(report.subagents.usage.byModel["test-provider:test-model"].tokens, {
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    reasoning: null,
    totalTokens: null,
  });
  assert.deepEqual(report.subagents.usage.byModel["test-provider:test-model"].cost, {
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    total: null,
  });
  assert.deepEqual(report.usage.combined.byModel["test-provider:test-model"].tokens, {
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    reasoning: null,
    totalTokens: null,
  });
  assert.deepEqual(report.usage.combined.byModel["test-provider:test-model"].cost, {
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    total: null,
  });
  assert.notEqual(report.subagents.tools, null);
  assert.notEqual(report.subagents.modelEvents, null);
  assert.equal(report.coverage.toolTimingComplete, true);
  assert.equal(report.coverage.modelEventsComplete, true);
  assert.equal(report.coverage.complete, false);
});

test("唯一 settled child 的未配对工具关闭全报告 tool timing", async (t) => {
  const childPath = await writeSession(t, [
    header(3, { id: "child-session", parentSession: "parent" }),
    user("child-user", null, 2),
    message("child-tool", "child-user", 3, "assistant", {
      content: [{ type: "toolCall", id: "unpaired", name: "child_tool", arguments: {} }],
      provider: "test-provider",
      model: "test-model",
      api: "test-api",
      usage: usage(),
      stopReason: "toolUse",
    }),
    assistant("child-done", "child-tool", 4),
  ]);
  const childUsage = { input: 20, output: 6, cacheWrite: 2, total: 28 };
  const record = lifecycle("spawn", childPath, {
    completedAt: BASE_TIME + 5000,
    durationMs: 4000,
    invocationToolUses: 1,
    invocationUsage: childUsage,
    lifetimeToolUses: 1,
    lifetimeUsage: childUsage,
  });
  const report = await parentReport(t, completeParent(childPath, record), "u1", "done", [childPath]);

  assert.ok(report.subagents?.tools);
  assert.equal(report.subagents.coverage.complete, true);
  assert.equal(report.subagents.tools.incompleteCalls, 1);
  assert.equal(report.subagents.tools.batchWaitSeconds, null);
  assert.equal(report.subagents.tools.criticalPathSeconds, null);
  assert.equal(report.subagents.tools.longestCallSeconds, null);
  assert.equal(report.coverage.toolTimingComplete, false);
  assert.equal(report.coverage.modelEventsComplete, true);
  assert.equal(report.coverage.complete, false);
});

test("完整 child 独立聚合工具失败与模型重试，且报告不泄露工具正文", async (t) => {
  const childPath = await writeSession(t, [
    header(3, { id: "child-session", parentSession: "parent" }),
    user("child-user", null, 2),
    message("child-tool", "child-user", 3, "assistant", {
      content: [{ type: "toolCall", id: "child-call", name: "child_tool", arguments: { secret: "PRIVATE_ARGUMENT" } }],
      provider: "test-provider",
      model: "test-model",
      api: "test-api",
      usage: usage(),
      stopReason: "toolUse",
    }),
    message("child-result", "child-tool", 4, "toolResult", {
      toolCallId: "child-call",
      toolName: "child_tool",
      content: "PRIVATE_OUTPUT",
      isError: true,
    }),
    message("child-error", "child-result", 5, "assistant", {
      content: [{ type: "text", text: "error" }],
      provider: "test-provider",
      model: "test-model",
      api: "test-api",
      usage: usage(),
      stopReason: "error",
    }),
    message("child-retry", "child-error", 6, "assistant", {
      content: [{ type: "text", text: "recovered" }],
      provider: "test-provider",
      model: "test-model",
      api: "test-api",
      usage: usage(),
      stopReason: "stop",
    }),
  ]);
  const childUsage = { input: 30, output: 9, cacheWrite: 3, total: 42 };
  const record = lifecycle("spawn", childPath, {
    completedAt: BASE_TIME + 7000,
    durationMs: 6000,
    invocationToolUses: 1,
    invocationUsage: childUsage,
    lifetimeToolUses: 1,
    lifetimeUsage: childUsage,
  });
  const report = await parentReport(t, completeParent(childPath, record), "u1", "done", [childPath]);

  assert.ok(report.subagents);
  assert.deepEqual(report.subagents.tools, {
    calls: 1,
    batches: 1,
    failures: 1,
    incompleteCalls: 0,
    orphanResults: 0,
    byTool: { child_tool: { calls: 1, failures: 1, incompleteCalls: 0 } },
    batchWaitSeconds: 1,
    criticalPathSeconds: 1,
    longestCallSeconds: 1,
  });
  assert.deepEqual(report.subagents.modelEvents, {
    responses: 3,
    failures: 1,
    automaticRetries: 1,
    turnsWithFailures: 1,
    recoveredTurns: 1,
    failedTurns: 0,
    statuses: { completed: 1, toolUse: 1, failed: 1, truncated: 0, aborted: 0, other: 0 },
    byModel: {
      "test-provider:test-model": {
        responses: 3,
        failures: 1,
        automaticRetries: 1,
        statuses: { completed: 1, toolUse: 1, failed: 1, truncated: 0, aborted: 0, other: 0 },
      },
    },
  });
  assert.equal(report.tools.calls, 1);
  assert.equal(report.time.toolCriticalPathSeconds, 1);
  assert.equal(report.usage.combined.tokens.input, 50);

  const serialized = JSON.stringify(report);
  for (const secret of ["PRIVATE_ARGUMENT", "PRIVATE_OUTPUT", "PRIVATE_DESCRIPTION", childPath, "outputFile"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});
