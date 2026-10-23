import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScopeDetailProjection,
  buildScopeProjection,
  buildScopeProjectionPage,
  buildSessionProjection,
  loadSourceSnapshot,
  MAX_SCOPE_DETAIL_BYTES,
  MAX_SCOPE_DETAIL_ENTRIES,
  MAX_SCOPE_DETAIL_TEXT_BYTES,
  MAX_SCOPE_PAGE_BYTES,
  MAX_SCOPE_PAGE_ENTRIES,
  ScopeDetailError,
  ScopePageError,
  type ScopeProjection,
  type ScopeProjectionPage,
  type SessionProjection,
} from "../src/core/index.ts";
import { assistant, entry, header, message, toolResult, user, writeSession } from "./fixtures.ts";

async function scopeFixture(t: Parameters<typeof writeSession>[0]) {
  const sourcePath = await writeSession(t, [
    header(),
    user("u1", null, 0, "u".repeat(5_000)),
    assistant("a1", "u1", 1, [
      { type: "text", text: "working" },
      { type: "thinking", thinking: "SECRET_THINKING" },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "SECRET_PATH" } },
    ]),
    toolResult("r1", "a1", 2, [{ type: "text", text: "SECRET_TOOL_RESULT" }]),
    message("r2", "r1", 3, "toolResult", {
      toolCallId: "call-2",
      toolName: "bash",
      content: [{ type: "text", text: "SECRET_ERROR_BODY" }],
      isError: true,
    }),
    entry("model_change", "m1", "r2", 4, { provider: "private-provider", modelId: "private-model" }),
    assistant("done", "m1", 5),
  ]);
  const snapshot = await loadSourceSnapshot(sourcePath);
  return buildSessionProjection(snapshot);
}

async function pagedScopeFixture(t: Parameters<typeof writeSession>[0], count: number, textBytes = 8) {
  const values: unknown[] = [header()];
  let parentId: string | null = null;
  for (let index = 0; index < count; index += 1) {
    const id = `u${index}`;
    values.push(user(id, parentId, index, "x".repeat(textBytes)));
    parentId = id;
  }
  const sourcePath = await writeSession(t, values);
  const snapshot = await loadSourceSnapshot(sourcePath);
  return buildScopeProjection(buildSessionProjection(snapshot));
}

async function emptyScopeFixture(t: Parameters<typeof writeSession>[0]) {
  const sourcePath = await writeSession(t, [
    header(),
    entry("model_change", "m1", null, 1, { provider: "private-provider", modelId: "private-model" }),
  ]);
  const snapshot = await loadSourceSnapshot(sourcePath);
  return buildScopeProjection(buildSessionProjection(snapshot));
}

test("紧凑范围投影只保留边界语义并限制单条文本", async (t) => {
  const projection = await scopeFixture(t);
  const scope = buildScopeProjection(projection);
  const serialized = JSON.stringify(scope);
  const sourceUser = scope.entries.find((entry) => entry.sourceEntryId === "u1");

  assert.deepEqual(scope.entries.map((entry) => entry.kind), ["user", "assistant", "tool_error", "assistant"]);
  assert.equal(sourceUser?.kind, "user");
  assert.equal(sourceUser?.content.originalBytes, 5_000);
  assert.equal(Buffer.byteLength(sourceUser?.content.text ?? "", "utf8"), 4_096);
  assert.equal(sourceUser?.content.truncated, true);
  assert.equal(scope.omitted.successfulToolResults, 1);
  assert.equal(scope.omitted.metadataEntries, 1);
  for (const secret of ["SECRET_THINKING", "SECRET_PATH", "SECRET_TOOL_RESULT", "SECRET_ERROR_BODY", "private-provider"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.equal(serialized.includes("sha256"), false);
  assert.ok(Object.isFrozen(scope));
  assert.ok(Object.isFrozen(scope.entries));
});

test("按需展开只返回有界脱敏片段", async (t) => {
  const projection = await scopeFixture(t);
  const detail = buildScopeDetailProjection(projection, "a1", "m1");
  const serialized = JSON.stringify(detail);

  assert.deepEqual(detail.entries.map((entry) => entry.kind), ["assistant", "tool_result", "tool_result", "metadata"]);
  assert.equal(detail.sourceEntryCount, 4);
  const expandedUser = buildScopeDetailProjection(projection, "u1", "u1").entries[0];
  assert.equal(expandedUser.kind, "user");
  assert.equal(Buffer.byteLength(expandedUser.kind === "user" ? expandedUser.content.text : "", "utf8"), 5_000);
  assert.equal(expandedUser.kind === "user" ? expandedUser.content.truncated : true, false);
  assert.equal(detail.entries.filter((entry) => entry.kind === "tool_result").every((entry) => entry.content === undefined), true);
  assert.equal(serialized.includes("SECRET_TOOL_RESULT"), false);
  assert.equal(serialized.includes("SECRET_ERROR_BODY"), false);
  assert.equal(serialized.includes("SECRET_THINKING"), false);
  assert.equal(serialized.includes("SECRET_PATH"), false);
  assert.throws(
    () => buildScopeDetailProjection(projection, "m1", "a1"),
    (error) => error instanceof ScopeDetailError && error.code === "invalid-range",
  );

  const inlineProjection = {
    ...projection,
    entries: projection.entries.map((entry) => entry.sourceEntryId === "r1" && entry.kind === "tool_result"
      ? { ...entry, textBlocks: ["SAFE_INLINE_RESULT"] }
      : entry),
  } as SessionProjection;
  const inlineDetail = buildScopeDetailProjection(inlineProjection, "r1", "r1");
  assert.equal(JSON.stringify(inlineDetail).includes("SAFE_INLINE_RESULT"), true);

  const largeProjection = {
    ...projection,
    entries: projection.entries.map((entry) => entry.sourceEntryId === "u1" && entry.kind === "user"
      ? { ...entry, textBlocks: ["长".repeat(20_000)] }
      : entry),
  } as SessionProjection;
  const largeDetail = buildScopeDetailProjection(largeProjection, "u1", "u1");
  const largeUser = largeDetail.entries[0];
  assert.equal(largeUser.kind, "user");
  assert.equal(Buffer.byteLength(largeUser.kind === "user" ? largeUser.content.text : "", "utf8") <= MAX_SCOPE_DETAIL_TEXT_BYTES, true);
  assert.equal(largeUser.kind === "user" ? largeUser.content.truncated : false, true);

  const outputProjection = {
    ...projection,
    entries: Array.from({ length: 4 }, (_value, index) => ({
      ...projection.entries[0],
      sourceEntryId: `large-${index}`,
      kind: "user" as const,
      textBlocks: ["界".repeat(MAX_SCOPE_DETAIL_TEXT_BYTES)],
    })),
  } as SessionProjection;
  assert.throws(
    () => buildScopeDetailProjection(outputProjection, "large-0", "large-3"),
    (error) => error instanceof ScopeDetailError && error.code === "output-too-large",
  );
  assert.equal(MAX_SCOPE_DETAIL_BYTES, 48_000);

  const repeated = Array.from({ length: MAX_SCOPE_DETAIL_ENTRIES + 1 }, (_value, index) => ({
    ...projection.entries[0],
    sourceEntryId: `entry-${index}`,
  }));
  const oversized = { ...projection, entries: repeated } as SessionProjection;
  assert.throws(
    () => buildScopeDetailProjection(oversized, "entry-0", `entry-${MAX_SCOPE_DETAIL_ENTRIES}`),
    (error) => error instanceof ScopeDetailError && error.code === "range-too-large",
  );
});

test("范围页默认返回最新一页并保留来源与省略统计", async (t) => {
  const scope = await pagedScopeFixture(t, 30);
  const page = buildScopeProjectionPage(scope);

  assert.equal(page.totalEntries, 30);
  assert.equal(page.startCursor, 0);
  assert.equal(page.endCursor, 30);
  assert.equal(page.previousCursor, null);
  assert.deepEqual(page.entries.map((entry) => entry.sourceEntryId), scope.entries.map((entry) => entry.sourceEntryId));
  assert.deepEqual(page.source, scope.source);
  assert.deepEqual(page.omitted, scope.omitted);
  assert.ok(Object.isFrozen(page));
  assert.ok(Object.isFrozen(page.entries));
  assert.equal(JSON.stringify(page).includes("private-provider"), false);
});

test("范围页按 80 条上限向前连续翻页且无重叠无遗漏", async (t) => {
  const scope = await pagedScopeFixture(t, 200);
  const latest = buildScopeProjectionPage(scope);
  assert.equal(latest.totalEntries, 200);
  assert.equal(latest.startCursor, 200 - MAX_SCOPE_PAGE_ENTRIES);
  assert.equal(latest.endCursor, 200);
  assert.equal(latest.previousCursor, 200 - MAX_SCOPE_PAGE_ENTRIES);
  assert.equal(latest.entries.length, MAX_SCOPE_PAGE_ENTRIES);
  assert.equal(latest.entries[0].sourceEntryId, `u${200 - MAX_SCOPE_PAGE_ENTRIES}`);
  assert.equal(latest.entries.at(-1)?.sourceEntryId, "u199");

  const middle = buildScopeProjectionPage(scope, latest.previousCursor!);
  assert.equal(middle.startCursor, 200 - 2 * MAX_SCOPE_PAGE_ENTRIES);
  assert.equal(middle.endCursor, latest.startCursor);
  assert.equal(middle.previousCursor, middle.startCursor);

  const earliest = buildScopeProjectionPage(scope, middle.previousCursor!);
  assert.equal(earliest.startCursor, 0);
  assert.equal(earliest.endCursor, middle.startCursor);
  assert.equal(earliest.previousCursor, null);

  const ids = [...earliest.entries, ...middle.entries, ...latest.entries].map((entry) => entry.sourceEntryId);
  assert.deepEqual(ids, scope.entries.map((entry) => entry.sourceEntryId));
  assert.equal(new Set(ids).size, 200);

  const beforeStart = buildScopeProjectionPage(scope, 0);
  assert.deepEqual(beforeStart.entries, []);
  assert.equal(beforeStart.startCursor, 0);
  assert.equal(beforeStart.endCursor, 0);
  assert.equal(beforeStart.previousCursor, null);
});

test("范围页按 32KB 上限收缩后翻页仍完整覆盖且每页不超过上限", async (t) => {
  const scope = await pagedScopeFixture(t, 30, 4_096);
  const pages: ScopeProjectionPage[] = [];
  let cursor: number | undefined;
  while (true) {
    const page = buildScopeProjectionPage(scope, cursor);
    pages.push(page);
    assert.ok(page.entries.length >= 1);
    assert.ok(page.entries.length <= MAX_SCOPE_PAGE_ENTRIES);
    assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= MAX_SCOPE_PAGE_BYTES);
    if (page.previousCursor === null) break;
    assert.notEqual(page.previousCursor, cursor);
    cursor = page.previousCursor;
    assert.ok(pages.length <= scope.entries.length);
  }
  assert.ok(pages.length > 2);
  assert.ok(pages.some((page) => page.entries.length < MAX_SCOPE_PAGE_ENTRIES));

  const ids = pages.toReversed().flatMap((page) => page.entries.map((entry) => entry.sourceEntryId));
  assert.deepEqual(ids, scope.entries.map((entry) => entry.sourceEntryId));
  for (let index = 1; index < pages.length; index += 1) {
    assert.equal(pages[index].endCursor, pages[index - 1].startCursor);
  }
});

test("范围页拒绝无法压缩到 32KB 内的单条异常 entry", async (t) => {
  const scope = await pagedScopeFixture(t, 1);
  const sourceEntry = scope.entries[0] as Extract<ScopeProjection["entries"][number], { kind: "user" }>;
  const oversizedEntry: ScopeProjection["entries"][number] = {
    ...sourceEntry,
    content: { text: "界".repeat(20_000), originalBytes: 60_000, truncated: true },
  };
  const oversized: ScopeProjection = { ...scope, entries: [oversizedEntry] };

  assert.throws(
    () => buildScopeProjectionPage(oversized),
    (error) => error instanceof ScopePageError && error.code === "output-too-large",
  );
});

test("范围页拒绝非法 cursor 并接受边界 cursor", async (t) => {
  const scope = await pagedScopeFixture(t, 3);
  for (const cursor of [-1, 4, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => buildScopeProjectionPage(scope, cursor),
      (error) => error instanceof ScopePageError && error.code === "invalid-cursor",
      `cursor ${cursor}`,
    );
  }
  const atEnd = buildScopeProjectionPage(scope, scope.entries.length);
  assert.deepEqual(atEnd, buildScopeProjectionPage(scope));
});

test("无 compact entry 时范围页返回合法空页", async (t) => {
  const scope = await emptyScopeFixture(t);
  assert.equal(scope.entries.length, 0);
  const page = buildScopeProjectionPage(scope);
  assert.deepEqual(page.entries, []);
  assert.equal(page.totalEntries, 0);
  assert.equal(page.startCursor, 0);
  assert.equal(page.endCursor, 0);
  assert.equal(page.previousCursor, null);
  assert.equal(page.omitted.metadataEntries, 1);
});
