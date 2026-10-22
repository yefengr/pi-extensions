import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTaskEfficiencyReport,
  loadSourceSnapshot,
  TaskRangeError,
  validateTaskRange,
} from "../core/index.ts";
import { entryTimestampMilliseconds } from "../core/range.ts";
import { assistant, entry, header, message, timestamp, usage, user, writeSession } from "./fixtures.ts";

function assistantWithReason(
  id: string,
  parentId: string,
  seconds: number,
  stopReason: string,
): Record<string, unknown> {
  return message(id, parentId, seconds, "assistant", {
    content: [{ type: "text", text: "assistant" }],
    provider: "test-provider",
    model: "test-model",
    api: "test-api",
    usage: usage(),
    stopReason,
  });
}

function rangeError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof TaskRangeError && error.code === code;
}

test("连续单 turn 与多 turn 范围生成深冻结 DTO", async (t) => {
  const snapshot = await loadSourceSnapshot(await writeSession(t, [
    header(),
    user("u1", null, 0),
    assistant("a1", "u1", 2),
    user("u2", "a1", 5),
    assistant("a2", "u2", 7),
  ]));
  const single = validateTaskRange(snapshot, { startEntryId: "u1", endEntryId: "a1" });
  const multiple = validateTaskRange(snapshot, { startEntryId: "u1", endEntryId: "a2" });

  assert.equal(single.entryCount, 2);
  assert.equal(multiple.turns.length, 2);
  assert.deepEqual(multiple.turns.map((turn) => turn.status), ["completed", "completed"]);
  assert.ok(Object.isFrozen(multiple));
  assert.ok(Object.isFrozen(multiple.turns));
  assert.ok(Object.isFrozen(multiple.turns[0]));
});

test("倒序、放弃分支和非 user 起点均失败关闭", async (t) => {
  const snapshot = await loadSourceSnapshot(await writeSession(t, [
    header(),
    user("u1", null, 0),
    assistant("a1", "u1", 1),
    user("abandoned", "a1", 2),
    assistant("abandoned-a", "abandoned", 3),
    user("u2", "a1", 4),
    assistant("a2", "u2", 5),
  ]));

  assert.throws(() => validateTaskRange(snapshot, { startEntryId: "a2", endEntryId: "u2" }), rangeError("invalid-range"));
  assert.throws(() => validateTaskRange(snapshot, { startEntryId: "u1", endEntryId: "abandoned-a" }), rangeError("invalid-range"));
  assert.throws(() => validateTaskRange(snapshot, { startEntryId: "a1", endEntryId: "a2" }), rangeError("range-start-not-user"));
});

test("未结束和非终态最终 assistant 被拒绝", async (t) => {
  for (const reason of ["toolUse", "pending", "deferred"] as const) {
    const snapshot = await loadSourceSnapshot(await writeSession(t, [
      header(),
      user("u1", null, 0),
      assistantWithReason("a1", "u1", 1, reason),
    ]));
    assert.throws(() => validateTaskRange(snapshot, { startEntryId: "u1", endEntryId: "a1" }), rangeError("range-final-incomplete"));
  }

  const unfinished = await loadSourceSnapshot(await writeSession(t, [header(), user("u1", null, 0)]));
  assert.throws(() => validateTaskRange(unfinished, { startEntryId: "u1", endEntryId: "u1" }), rangeError("range-final-incomplete"));
});

test("superseded turn 保留最后 assistant 的原生 stopReason", async (t) => {
  const snapshot = await loadSourceSnapshot(await writeSession(t, [
    header(),
    user("u1", null, 0),
    assistantWithReason("a1", "u1", 1, "toolUse"),
    user("u2", "a1", 2),
    assistant("a2", "u2", 3),
  ]));
  const range = validateTaskRange(snapshot, { startEntryId: "u1", endEntryId: "a2" });
  assert.deepEqual(range.turns.map((turn) => [turn.status, turn.stopReason, turn.settled]), [
    ["superseded", "toolUse", true],
    ["completed", "stop", true],
  ]);
});

test("没有 assistant 的 superseded turn 保留 null stopReason", async (t) => {
  const snapshot = await loadSourceSnapshot(await writeSession(t, [
    header(),
    user("u1", null, 0),
    message("note", "u1", 1, "custom", { customType: "note", content: "interrupted", display: false }),
    user("u2", "note", 2),
    assistant("a2", "u2", 3),
  ]));
  const range = validateTaskRange(snapshot, { startEntryId: "u1", endEntryId: "a2" });
  assert.deepEqual(range.turns.map((turn) => [turn.status, turn.stopReason, turn.settled]), [
    ["superseded", null, true],
    ["completed", "stop", true],
  ]);
});

test("不可表示的 user message timestamp 回退外层时间且报告不抛出 RangeError", async (t) => {
  const snapshot = await loadSourceSnapshot(await writeSession(t, [
    header(),
    message("u1", null, 0, "user", { content: "user", timestamp: 1e20 }),
    assistant("a1", "u1", 1),
  ]));
  const range = validateTaskRange(snapshot, { startEntryId: "u1", endEntryId: "a1" });
  const report = await buildTaskEfficiencyReport(snapshot, range);

  assert.equal(range.turns[0].startTimestamp, timestamp(0));
  assert.equal(report.range.startTimestamp, timestamp(0));
  assert.equal(report.time.wallClockSpanSeconds, 1);
});

test("伪装 user message 的 known 或 unknown entry 仍使用外层时间", async (t) => {
  for (const candidate of [
    entry("custom", "note", "u1", 4, {
      customType: "note",
      message: { role: "user", timestamp: Date.parse("2026-09-07T00:00:00.010Z") },
    }),
    entry("future_entry", "note", "u1", 4, {
      message: { role: "user", timestamp: Date.parse("2026-09-07T00:00:00.010Z") },
    }),
  ]) {
    const snapshot = await loadSourceSnapshot(await writeSession(t, [
      header(),
      user("u1", null, 0),
      candidate,
      user("u2", "note", 5),
      assistant("a2", "u2", 6),
    ]));
    const range = validateTaskRange(snapshot, { startEntryId: "u1", endEntryId: "a2" });

    assert.equal(range.turns[0].status, "superseded");
    assert.equal(range.turns[0].endTimestamp, timestamp(4));
  }
});

test("user 使用提交时间，assistant 使用完成落盘时间", async (t) => {
  const sourceUser = message("u1", null, 0, "user", {
    content: "user",
    timestamp: Date.parse("2026-09-07T00:00:00.005Z"),
  });
  const sourceAssistant = assistant("a1", "u1", 14) as Record<string, any>;
  sourceAssistant.message.timestamp = Date.parse("2026-09-07T00:00:00.010Z");
  const snapshot = await loadSourceSnapshot(await writeSession(t, [header(), sourceUser, sourceAssistant]));
  const range = validateTaskRange(snapshot, { startEntryId: "u1", endEntryId: "a1" });
  const report = await buildTaskEfficiencyReport(snapshot, range);

  assert.equal(range.turns[0].startTimestamp, "2026-09-07T00:00:00.005Z");
  assert.equal(range.turns[0].endTimestamp, timestamp(14));
  assert.equal(report.time.wallClockSpanSeconds, 13.995);
});

test("非 user message 外层时间不可用时回退内层时间", () => {
  const timestamp = Date.parse("2026-09-07T00:00:01.250Z");
  const candidate = {
    recognition: "known",
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "invalid",
    raw: { message: { role: "assistant", timestamp } },
  } as const;

  assert.equal(entryTimestampMilliseconds(candidate), timestamp);
});
