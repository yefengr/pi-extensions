import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildSessionProjection,
  loadSourceSnapshot,
  SourceSnapshotError,
} from "../src/core/index.ts";
import {
  assistant,
  BASE_TIME,
  entry,
  header,
  lifecycleRecord,
  message,
  toolResult,
  user,
  writeSession,
} from "./fixtures.ts";

function errorCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof SourceSnapshotError && error.code === code;
}

async function richSnapshot(t: Parameters<typeof writeSession>[0]) {
  const values = [
    header(),
    user("u1", null, 1, [
      { type: "text", text: "user text" },
      { type: "image", data: "SECRET_IMAGE", mimeType: "image/png" },
    ]),
    assistant("a1", "u1", 2, [
      { type: "text", text: "assistant text" },
      { type: "thinking", thinking: "SECRET_THINKING" },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "SECRET_ARGUMENT" } },
    ]),
    toolResult("r1", "a1", 3, [
      { type: "text", text: "abc" },
      { type: "image", data: "SECRET_TOOL_IMAGE", mimeType: "image/png" },
    ]),
    entry("compaction", "c1", "r1", 4, {
      summary: "compaction summary",
      firstKeptEntryId: "u1",
      tokensBefore: 22,
      retainedTail: [{ role: "user", content: "SECRET_RETAINED" }],
    }),
    entry("branch_summary", "b1", "c1", 5, {
      summary: "branch summary",
      fromId: "u1",
      retainedTail: [{ role: "user", content: "SECRET_BRANCH_RETAINED" }],
    }),
    entry("custom", "l1", "b1", 6, {
      customType: "subagents:record",
      data: lifecycleRecord(),
    }),
    entry("custom", "bad-record", "l1", 7, {
      customType: "subagents:record",
      data: lifecycleRecord({ recordVersion: 1, result: "SECRET_BAD_RESULT" }),
    }),
    message("bash", "bad-record", 8, "bashExecution", {
      command: "SECRET_COMMAND",
      output: "SECRET_BASH_OUTPUT",
      exitCode: 0,
      cancelled: false,
      truncated: false,
    }),
    message("custom", "bash", 9, "custom", {
      customType: "extension-event",
      content: "SECRET_CUSTOM_CONTENT",
      display: false,
    }),
    entry("future_entry", "future", "custom", 10, { secret: "SECRET_UNKNOWN_RAW" }),
  ];
  return loadSourceSnapshot(await writeSession(t, values));
}

test("默认投影逐 entry 映射，保留安全字段并省略敏感块", async (t) => {
  const snapshot = await richSnapshot(t);
  const projection = buildSessionProjection(snapshot);
  const serialized = JSON.stringify(projection);
  const tool = projection.entries.find((item) => item.kind === "tool_result");
  const lifecycle = projection.entries.find((item) => item.kind === "subagent");
  const invalidLifecycle = projection.entries.find((item) => item.sourceEntryId === "bad-record");
  const compaction = projection.entries.find((item) => item.kind === "compaction");

  assert.equal(projection.entries.length, snapshot.activeBranch.length);
  assert.ok(tool);
  assert.equal("textBlocks" in tool, false);
  assert.ok(lifecycle);
  assert.deepEqual(lifecycle.record, {
    recordVersion: 2,
    id: "agent-1",
    type: "deepseek-flash-standard-worker",
    status: "completed",
    invocationKind: "fresh",
    invocationIndex: 1,
    toolCallId: "call-1",
    sessionState: "created",
    sessionId: "child-session",
    startedAt: BASE_TIME + 1000,
    completedAt: BASE_TIME + 2000,
  });
  assert.ok(invalidLifecycle);
  assert.equal(invalidLifecycle.kind, "metadata");
  assert.ok(compaction);
  assert.deepEqual(compaction, {
    sourceEntryId: "c1",
    parentId: "r1",
    timestamp: snapshot.entries[3].timestamp,
    omissionIds: [],
    kind: "compaction",
    summary: "compaction summary",
    firstKeptEntryId: "u1",
    tokensBefore: 22,
  });
  for (const secret of [
    "SECRET_IMAGE",
    "SECRET_THINKING",
    "SECRET_ARGUMENT",
    "SECRET_TOOL_IMAGE",
    "SECRET_RETAINED",
    "SECRET_BRANCH_RETAINED",
    "SECRET_BAD_RESULT",
    "SECRET_COMMAND",
    "SECRET_BASH_OUTPUT",
    "SECRET_CUSTOM_CONTENT",
    "SECRET_UNKNOWN_RAW",
    "PRIVATE_DESCRIPTION",
    "private result",
    "/private/child.jsonl",
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.equal(serialized.includes("\"invocationUsage\""), false);
  assert.equal(serialized.includes("\"lifetimeUsage\""), false);
  assert.ok(projection.omissions.some((item) => item.sourceEntryId === "future" && item.reason === "unsupported_entry"));
  assert.ok(projection.omissions.some((item) => item.sourceEntryId === "l1" && item.field === "data"));
  assert.ok(Object.isFrozen(projection.entries));
  assert.ok(Object.isFrozen(projection.omissions));
});

test("工具结果文本按 UTF-8 总字节阈值整体内联或整体省略", async (t) => {
  const path = await writeSession(t, [
    header(),
    user("u1", null, 1),
    assistant("a1", "u1", 2),
    toolResult("r1", "a1", 3, [{ type: "text", text: "abc" }, { type: "image", data: "image", mimeType: "image/png" }]),
  ]);
  const snapshot = await loadSourceSnapshot(path);
  const defaults = buildSessionProjection(snapshot);
  const exact = buildSessionProjection(snapshot, { maxInlineToolResultBytes: 3 });
  const over = buildSessionProjection(snapshot, { maxInlineToolResultBytes: 2 });
  const defaultTool = defaults.entries.at(-1);
  const exactTool = exact.entries.at(-1);
  const overTool = over.entries.at(-1);

  assert.ok(defaultTool && defaultTool.kind === "tool_result");
  assert.equal("textBlocks" in defaultTool, false);
  assert.ok(exactTool && exactTool.kind === "tool_result");
  assert.deepEqual(exactTool.textBlocks, ["abc"]);
  assert.ok(overTool && overTool.kind === "tool_result");
  assert.equal("textBlocks" in overTool, false);
  assert.deepEqual(
    over.omissions.filter((item) => item.sourceEntryId === "r1").map((item) => [item.field, item.reason]),
    [["message.content[0].text", "content_limit"], ["message.content[1]", "not_projected"]],
  );

  const emptyPath = await writeSession(t, [
    header(),
    user("u1", null, 1),
    assistant("a1", "u1", 2),
    toolResult("empty-array", "a1", 3, []),
    toolResult("empty-string", "empty-array", 4, ""),
    toolResult("empty-block", "empty-string", 5, [{ type: "text", text: "" }]),
  ]);
  const emptySnapshot = await loadSourceSnapshot(emptyPath);
  const metadataOnly = buildSessionProjection(emptySnapshot);
  const zeroByteInline = buildSessionProjection(emptySnapshot, { maxInlineToolResultBytes: 1 });

  for (const item of metadataOnly.entries.slice(-3)) {
    assert.ok(item.kind === "tool_result");
    assert.equal("textBlocks" in item, false);
  }
  assert.deepEqual(
    zeroByteInline.entries.slice(-3).map((item) => item.kind === "tool_result" ? item.textBlocks : undefined),
    [[], [""], [""]],
  );
});

test("非法选项失败关闭，规范化默认值与同一快照投影稳定", async (t) => {
  const snapshot = await richSnapshot(t);
  const defaults = buildSessionProjection(snapshot);
  const repeated = buildSessionProjection(snapshot, {});

  assert.deepEqual(defaults, repeated);
  assert.deepEqual(defaults.options, { maxInlineToolResultBytes: 0 });
  await assert.rejects(async () => buildSessionProjection(snapshot, { maxInlineToolResultBytes: -1 }), errorCode("invalid-options"));
  await assert.rejects(async () => buildSessionProjection(snapshot, { maxInlineToolResultBytes: 1.5 }), errorCode("invalid-options"));
});

test("省略项对同一快照和配置稳定，且哈希与源值一致", async (t) => {
  const privateText = "PRIVATE" + String.fromCodePoint(0x1f680);
  const path = await writeSession(t, [
    header(),
    user("u1", null, 1),
    assistant("a1", "u1", 2),
    toolResult("r1", "a1", 3, privateText),
  ]);
  const snapshot = await loadSourceSnapshot(path);
  const first = buildSessionProjection(snapshot);
  const second = buildSessionProjection(snapshot);
  const firstOmission = first.omissions.find((item) => item.sourceEntryId === "r1" && item.field === "message.content");
  const secondOmission = second.omissions.find((item) => item.sourceEntryId === "r1" && item.field === "message.content");

  assert.ok(firstOmission);
  assert.deepEqual(secondOmission, firstOmission);
  assert.deepEqual(firstOmission, {
    id: createHash("sha256").update(["r1", "message.content"].join(String.fromCharCode(0)), "utf8").digest("hex"),
    sourceEntryId: "r1",
    field: "message.content",
    reason: "content_limit",
    byteLength: Buffer.byteLength(privateText, "utf8"),
    sha256: createHash("sha256").update(privateText, "utf8").digest("hex"),
  });
});

test("v2 hookMessage 和 v3 metadata role 只映射 metadata，不注入正文", async (t) => {
  const v2Path = await writeSession(t, [
    header(2),
    user("u1", null, 1),
    message("hook", "u1", 2, "hookMessage", { customType: "legacy", content: "SECRET_HOOK", display: true }),
  ]);
  const v2Projection = buildSessionProjection(await loadSourceSnapshot(v2Path));
  const v2Last = v2Projection.entries.at(-1);
  assert.ok(v2Last && v2Last.kind === "metadata");
  assert.equal(JSON.stringify(v2Projection).includes("SECRET_HOOK"), false);

  const v3Path = await writeSession(t, [
    header(),
    user("u1", null, 1),
    message("branch", "u1", 2, "branchSummary", { summary: "SECRET_BRANCH_MESSAGE", fromId: "u1" }),
    message("compact", "branch", 3, "compactionSummary", { summary: "SECRET_COMPACTION_MESSAGE", tokensBefore: 3 }),
  ]);
  const v3Projection = buildSessionProjection(await loadSourceSnapshot(v3Path));
  assert.deepEqual(v3Projection.entries.map((item) => item.kind), ["user", "metadata", "metadata"]);
  assert.equal(JSON.stringify(v3Projection).includes("SECRET_BRANCH_MESSAGE"), false);
  assert.equal(JSON.stringify(v3Projection).includes("SECRET_COMPACTION_MESSAGE"), false);
});

test("lifecycle v2 有效 not-created service 记录规范化 null，且不会读取 child 引用", async (t) => {
  const path = await writeSession(t, [
    header(),
    user("u1", null, 1),
    entry("custom", "record", "u1", 2, {
      customType: "subagents:record",
      data: lifecycleRecord({
        status: "stopped",
        invocationSource: "service",
        toolCallId: undefined,
        sessionState: "not-created",
        sessionId: undefined,
        outputFile: undefined,
      }),
    }),
  ]);
  const snapshot = await loadSourceSnapshot(path);
  const projection = buildSessionProjection(snapshot);
  const item = projection.entries.at(-1);

  assert.ok(item && item.kind === "subagent");
  assert.equal(item.record.toolCallId, null);
  assert.equal(item.record.sessionId, null);
  assert.equal(item.record.sessionState, "not-created");
});

test("lifecycle v2 无效持久化字段仅降级为 metadata", async (t) => {
  const invalidRecords = [
    lifecycleRecord({ description: undefined }),
    lifecycleRecord({ description: "not" + String.fromCharCode(10) + "sanitized" }),
    lifecycleRecord({ sessionState: "not-created", sessionId: undefined, outputFile: undefined }),
    lifecycleRecord({ outputFile: "" }),
    lifecycleRecord({ durationMs: 999 }),
    lifecycleRecord({ invocationUsage: { input: 1, output: 2, cacheWrite: 3, total: 5 } }),
  ];
  const values: unknown[] = [header(), user("u1", null, 1)];
  let parentId = "u1";
  for (const [index, data] of invalidRecords.entries()) {
    const id = `invalid-${index}`;
    values.push(entry("custom", id, parentId, index + 2, { customType: "subagents:record", data }));
    parentId = id;
  }

  const projection = buildSessionProjection(await loadSourceSnapshot(await writeSession(t, values)));
  assert.deepEqual(projection.entries.slice(-invalidRecords.length).map((item) => item.kind), Array(invalidRecords.length).fill("metadata"));
});
