import assert from "node:assert/strict";
import test from "node:test";

import { buildScopeDetailProjection, buildScopeProjection, buildSessionProjection, loadSourceSnapshot } from "../src/core/index.ts";
import { parseLifecycleRecord } from "../src/core/lifecycle.ts";
import { entry, header, lifecycleRecord, lifecycleRecordV3, user, writeSession } from "./fixtures.ts";

const OUTCOMES = ["completed", "turn_limit", "timeout", "queue_timeout", "cancelled", "error"] as const;

function assertInvalid(value: unknown, label: string): void {
  assert.deepEqual(parseLifecycleRecord(value), { record: null, unsupported: false }, label);
}

test("v2 保留全部历史终态、调用来源和 no-session 校验", () => {
  for (const status of ["completed", "steered", "aborted", "stopped", "error"]) {
    const parsed = parseLifecycleRecord(lifecycleRecord({ status, error: "private error" }));
    assert.equal(parsed.record?.recordVersion, 2);
    assert.equal(parsed.record?.status, status);
  }
  for (const status of ["error", "stopped"]) {
    const parsed = parseLifecycleRecord(lifecycleRecord({
      status, error: "private error", sessionState: "not-created", sessionId: undefined, outputFile: undefined,
      invocationSource: "service", toolCallId: undefined,
    }));
    assert.equal(parsed.record?.sessionId, null);
    assert.equal(parsed.record?.toolCallId, null);
    assert.equal(parsed.record?.outputFile, null);
  }
  for (const overrides of [{ status: "cancelled" }, { result: undefined }, { status: "error", error: undefined }]) {
    assertInvalid(lifecycleRecord(overrides), JSON.stringify(overrides));
  }
});

test("v3 六种 outcome 原样成为 status，fresh/resume/service 共用身份规范", () => {
  for (const outcome of OUTCOMES) {
    const parsed = parseLifecycleRecord(lifecycleRecordV3({ outcome }));
    assert.equal(parsed.unsupported, false);
    assert.equal(parsed.record?.recordVersion, 3);
    assert.equal(parsed.record?.status, outcome);
  }
  const resume = parseLifecycleRecord(lifecycleRecordV3({ invocationKind: "resume", invocationIndex: 2 }));
  assert.equal(resume.record?.invocationKind, "resume");
  assert.equal(resume.record?.invocationIndex, 2);
  const service = parseLifecycleRecord(lifecycleRecordV3({ invocationSource: "service", toolCallId: undefined }));
  assert.equal(service.record?.invocationSource, "service");
  assert.equal(service.record?.toolCallId, null);
});

test("v3 no-session 只接受 error/cancelled/queue_timeout 且禁止引用伪 child", () => {
  for (const outcome of OUTCOMES) {
    const record = lifecycleRecordV3({ outcome, sessionState: "not-created", sessionId: undefined, outputFile: undefined });
    const parsed = parseLifecycleRecord(record);
    if (["error", "cancelled", "queue_timeout"].includes(outcome)) {
      assert.equal(parsed.record?.sessionId, null);
      assert.equal(parsed.record?.outputFile, null);
      assertInvalid({ ...record, sessionId: "invented-child" }, outcome);
      assertInvalid({ ...record, outputFile: "/untrusted/child.jsonl" }, outcome);
    } else {
      assertInvalid(record, outcome);
    }
  }
});

test("v2/v3 拒绝损坏的身份、调用、时间和 usage，而非标记为未来协议", () => {
  const invalid: Record<string, unknown>[] = [
    { id: " " }, { type: "" }, { description: undefined }, { description: "a\nb" },
    { isBackground: "false" }, { invocationKind: "other" }, { invocationSource: "other" },
    { invocationIndex: 0 }, { invocationIndex: 1.5 }, { invocationIndex: 2 },
    { invocationKind: "resume", invocationIndex: 1 }, { toolCallId: " " },
    { invocationSource: "service" },
    { invocationSource: "service", toolCallId: undefined, invocationKind: "resume", invocationIndex: 2 },
    { sessionState: "unknown" }, { sessionId: " " }, { outputFile: "" },
    { sessionState: "not-created", sessionId: undefined, outputFile: undefined },
    { startedAt: -1 }, { startedAt: Number.NaN }, { completedAt: undefined },
    { completedAt: Number.POSITIVE_INFINITY }, { completedAt: 0 }, { durationMs: -1 }, { durationMs: 999 },
    { invocationToolUses: -1 }, { invocationToolUses: 0.5 }, { lifetimeToolUses: 0 },
    { invocationUsage: null },
    { invocationUsage: { input: 1, output: 2, cacheWrite: 3, total: 5 } },
    { invocationUsage: { input: -1, output: 2, cacheWrite: 3, total: 4 } },
    { lifetimeUsage: { input: 0, output: 4, cacheWrite: 6, total: 10 } },
  ];
  for (const fixture of [lifecycleRecord, lifecycleRecordV3]) {
    for (const [index, overrides] of invalid.entries()) assertInvalid(fixture(overrides), `case ${index}`);
    for (const field of ["input", "output", "cacheWrite", "total"]) {
      for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, "1", undefined]) {
        for (const usageField of ["invocationUsage", "lifetimeUsage"]) {
          const record = fixture();
          assertInvalid({ ...record, [usageField]: { ...record[usageField] as object, [field]: value } }, `${usageField}.${field}`);
        }
      }
    }
  }
});

test("v3 拒绝非终态、未知 outcome 以及损坏的 turn/resource 值", () => {
  for (const overrides of [
    { phase: "queued" }, { phase: "running" }, { phase: undefined },
    { outcome: undefined }, { outcome: "stopped" }, { outcome: "future-outcome" },
    { lifetimeTurnCount: 0 }, { wrapUpTurns: 20 }, { result: 1 }, { error: {} },
  ]) assertInvalid(lifecycleRecordV3(overrides), JSON.stringify(overrides));
  for (const field of ["invocationTurnCount", "lifetimeTurnCount", "maxTurns", "wrapUpTurns", "maxDurationSeconds"]) {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", undefined]) {
      assertInvalid(lifecycleRecordV3({ [field]: value }), field);
    }
  }
  for (const field of ["maxTurns", "maxDurationSeconds"]) assertInvalid(lifecycleRecordV3({ [field]: 0 }), field);
  assert.ok(parseLifecycleRecord(lifecycleRecordV3({ invocationTurnCount: 0, lifetimeTurnCount: 0, maxTurns: 1, wrapUpTurns: 0 })).record);
});

test("非对象和损坏版本属于 invalid，未知整数版本才是 unsupported", () => {
  for (const value of [null, undefined, [], 3, "record"]) assertInvalid(value, String(value));
  for (const recordVersion of [undefined, null, "3", 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assertInvalid(lifecycleRecordV3({ recordVersion }), String(recordVersion));
  }
  for (const recordVersion of [0, 1, 4]) {
    assert.deepEqual(parseLifecycleRecord(lifecycleRecordV3({ recordVersion })), { record: null, unsupported: true });
  }
});

test("normalized usage 不携带扩展正文，v3 投影/范围只保留既有安全字段", async (t) => {
  const privateFields = {
    description: "PRIVATE_DESCRIPTION", result: "PRIVATE_RESULT", error: "PRIVATE_ERROR", outputFile: "/PRIVATE_OUTPUT_FILE",
  };
  const record = lifecycleRecordV3({
    ...privateFields,
    invocationUsage: { input: 1, output: 2, cacheWrite: 3, total: 6, secret: "PRIVATE_NESTED_USAGE" },
  });
  const normalized = parseLifecycleRecord(record).record;
  assert.ok(normalized);
  for (const field of ["description", "result", "error"]) assert.equal(field in normalized, false);
  assert.equal(JSON.stringify(normalized).includes("PRIVATE_NESTED_USAGE"), false);
  const values: unknown[] = [header(), user("u1", null, 0)];
  let parentId = "u1";
  for (const [index, outcome] of OUTCOMES.entries()) {
    const id = `record-${index}`;
    values.push(entry("custom", id, parentId, index + 1, { customType: "subagents:record", data: { ...record, outcome } }));
    parentId = id;
  }
  values.push(entry("custom", "invalid", parentId, 9, { customType: "subagents:record", data: { ...record, phase: "running" } }));
  values.push(entry("custom", "future", "invalid", 10, { customType: "subagents:record", data: { ...record, recordVersion: 4 } }));
  const projection = buildSessionProjection(await loadSourceSnapshot(await writeSession(t, values)));
  const projected = projection.entries.filter((item) => item.kind === "subagent");
  assert.equal(projected.length, OUTCOMES.length);
  assert.deepEqual(projected.map((item) => item.record.status), OUTCOMES);
  assert.deepEqual(projected[0].record, {
    recordVersion: 3, id: "agent-1", type: "deepseek-flash-standard-worker", status: "completed",
    invocationKind: "fresh", invocationIndex: 1, toolCallId: "call-1", sessionState: "created", sessionId: "child-session",
    startedAt: record.startedAt, completedAt: record.completedAt,
  });
  assert.deepEqual(projection.entries.slice(-2).map((item) => item.kind), ["metadata", "metadata"]);
  const scope = buildScopeProjection(projection);
  const detail = buildScopeDetailProjection(projection, "record-0", "future");
  for (const output of [projection, scope, detail]) {
    for (const secret of [...Object.values(privateFields), "PRIVATE_NESTED_USAGE"]) {
      assert.equal(JSON.stringify(output).includes(secret), false, secret);
    }
  }
});
