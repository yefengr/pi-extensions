import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  assertSnapshotMatches,
  buildActiveBranch,
  buildSessionProjection,
  compareSourceSnapshots,
  loadSourceSnapshot,
  SourceSnapshotError,
  SnapshotMismatchError,
} from "../core/index.ts";
import { assistant, entry, header, message, timestamp, usage, user, writeSession } from "./fixtures.ts";

function errorCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof SourceSnapshotError && error.code === code;
}

test("v2、v3、空 session 与无换行完整末行产生稳定不可变快照", async (t) => {
  const v2Path = await writeSession(t, [
    header(2),
    user("u1", null, 1),
    message("hook", "u1", 2, "hookMessage", {
      customType: "legacy-hook",
      content: "legacy metadata",
      display: false,
    }),
  ], { finalNewline: false });
  const v2 = await loadSourceSnapshot(v2Path, { now: () => new Date(timestamp(10)) });
  const v3Path = await writeSession(t, [header(3, { parentSession: "parent-session" })]);
  const v3 = await loadSourceSnapshot(v3Path);

  assert.equal(v2.sessionVersion, 2);
  assert.deepEqual(v2.activeBranch.map((item) => item.id), ["u1", "hook"]);
  assert.equal(v3.activeLeafId, null);
  assert.equal(v3.parentSessionId, "parent-session");
  assert.deepEqual(v3.entries, []);
  assert.equal(v2.capturedAt, timestamp(10));
  assert.ok(Object.isFrozen(v2));
  assert.ok(Object.isFrozen(v2.entries));
  assert.ok(Object.isFrozen(v2.entries[0].raw));
  assert.ok(Object.isFrozen(buildSessionProjection(v2)));
});

test("每次加载恰好调用一次 reader，digest、leaf 与投影来自同一字节副本", async () => {
  const values = [header(), user("u1", null, 1), assistant("a1", "u1", 2)];
  const contents = Buffer.from(values.map((value) => JSON.stringify(value)).join("\n"), "utf8");
  let calls = 0;
  const snapshot = await loadSourceSnapshot("/virtual/session.jsonl", {
    readFile: async () => {
      calls += 1;
      return contents;
    },
    now: () => new Date(timestamp(5)),
  });

  assert.equal(calls, 1);
  assert.equal(snapshot.activeLeafId, "a1");
  assert.equal(snapshot.byteLength, contents.byteLength);
  assert.equal(buildSessionProjection(snapshot).source.digest, snapshot.digest);
});

test("全树校验排除放弃分支并拒绝任何分支中的结构错误", async (t) => {
  const validPath = await writeSession(t, [
    header(),
    user("u1", null, 1),
    assistant("a1", "u1", 2),
    user("abandoned", "a1", 3),
    assistant("abandoned-a", "abandoned", 4),
    user("active", "a1", 5),
  ]);
  const valid = await loadSourceSnapshot(validPath);
  assert.deepEqual(valid.activeBranch.map((item) => item.id), ["u1", "a1", "active"]);

  const invalidPath = await writeSession(t, [
    header(),
    user("u1", null, 1),
    assistant("bad", "missing", 2),
    assistant("active", "u1", 3),
  ]);
  await assert.rejects(loadSourceSnapshot(invalidPath), errorCode("invalid-tree"));
});

test("header、编码、JSONL、版本、基础字段与已知字段都失败关闭", async (t) => {
  const invalidHeader = await writeSession(t, [{ ...header(), cwd: "" }]);
  const invalidParent = await writeSession(t, [header(3, { parentSession: "" })]);
  const versionOne = await writeSession(t, [header(3, { version: 1 })]);
  const futureVersion = await writeSession(t, [header(3, { version: 4 })]);
  const blankLine = await writeSession(t, [header()], { suffix: "\n" });
  const incompleteTail = await writeSession(t, [header()], { finalNewline: false, suffix: "\n{\"type\":" });
  const invalidJson = await writeSession(t, [header()], { suffix: "{not-json}\n" });
  const invalidBase = await writeSession(t, [header(), { type: "future", id: "x", parentId: null, timestamp: "not-iso" }]);
  const missingCompactionField = await writeSession(t, [
    header(),
    entry("compaction", "c1", null, 1, { summary: "summary", tokensBefore: 10 }),
  ]);
  const invalidUtf8 = "/virtual/invalid-utf8.jsonl";

  await assert.rejects(loadSourceSnapshot(invalidHeader), errorCode("invalid-header"));
  await assert.rejects(loadSourceSnapshot(invalidParent), errorCode("invalid-header"));
  await assert.rejects(loadSourceSnapshot(versionOne), errorCode("unsupported-version"));
  await assert.rejects(loadSourceSnapshot(futureVersion), errorCode("unsupported-version"));
  await assert.rejects(loadSourceSnapshot(blankLine), errorCode("blank-line"));
  await assert.rejects(loadSourceSnapshot(incompleteTail), errorCode("incomplete-tail"));
  await assert.rejects(loadSourceSnapshot(invalidJson), errorCode("invalid-json"));
  await assert.rejects(loadSourceSnapshot(invalidBase), errorCode("invalid-entry"));
  await assert.rejects(loadSourceSnapshot(missingCompactionField), errorCode("invalid-entry"));
  await assert.rejects(loadSourceSnapshot(invalidUtf8, { readFile: async () => Buffer.from([0xc3, 0x28]) }), errorCode("invalid-utf8"));
});

test("assistant stopReason 仅接受 pi-ai 完整枚举", async (t) => {
  const assistantMessage = (id: string, stopReason: string) => message(id, "u1", 2, "assistant", {
    content: [{ type: "text", text: "assistant text" }],
    provider: "test-provider",
    model: "test-model",
    api: "test-api",
    usage: usage(),
    stopReason,
  });
  const deferred = await writeSession(t, [header(), user("u1", null, 1), assistantMessage("a1", "deferred")]);
  const invented = await writeSession(t, [header(), user("u1", null, 1), assistantMessage("a1", "invented")]);

  assert.equal((await loadSourceSnapshot(deferred)).entries.at(-1)?.id, "a1");
  await assert.rejects(loadSourceSnapshot(invented), errorCode("invalid-entry"));
});

test("重复 ID、多 root、orphan、forward parent 和已知 role 损坏拒绝为 unknown", async (t) => {
  const cases: readonly [string, readonly unknown[]][] = [
    ["duplicate", [header(), user("u1", null, 1), assistant("u1", "u1", 2)]],
    ["multiple-root", [header(), user("u1", null, 1), user("u2", null, 2)]],
    ["orphan", [header(), user("u1", null, 1), assistant("a1", "none", 2)]],
    ["forward", [header(), user("u1", "a1", 1), assistant("a1", null, 2)]],
    ["bad-role", [header(), message("u1", null, 1, "user", { content: 5 })]],
  ];
  for (const [, values] of cases) {
    const filePath = await writeSession(t, values);
    await assert.rejects(loadSourceSnapshot(filePath));
  }
});

test("快照比较拒绝追加和替换，并在成功时交回新快照", async (t) => {
  const filePath = await writeSession(t, [header(), user("u1", null, 1)]);
  const first = await loadSourceSnapshot(filePath);
  const same = await loadSourceSnapshot(filePath);
  const match = compareSourceSnapshots(first, same);
  assert.equal(match.matches, true);
  assert.equal(assertSnapshotMatches(first, same), same);

  await appendFile(filePath, `${JSON.stringify(assistant("a1", "u1", 2))}\n`, "utf8");
  const appended = await loadSourceSnapshot(filePath);
  assert.equal(compareSourceSnapshots(first, appended).matches, false);
  assert.throws(() => assertSnapshotMatches(first, appended), SnapshotMismatchError);

  await writeFile(filePath, `${JSON.stringify(header())}\n`, "utf8");
  const replaced = await loadSourceSnapshot(filePath);
  assert.throws(() => assertSnapshotMatches(appended, replaced), SnapshotMismatchError);
});

test("加载不写源文件，未知 entry 只作为 warning 保留内存 raw", async (t) => {
  const filePath = await writeSession(t, [
    header(),
    user("u1", null, 1),
    entry("future_entry", "future", "u1", 2, { secret: "not-projected" }),
  ]);
  const before = await readFile(filePath, "utf8");
  const snapshot = await loadSourceSnapshot(filePath);
  const after = await readFile(filePath, "utf8");

  assert.equal(before, after);
  assert.deepEqual(snapshot.warnings, [{ code: "unknown_entry", entryId: "future", entryType: "future_entry" }]);
  assert.equal(snapshot.entries[1].recognition, "unknown");
});

test("活动分支回溯保留缺失 parent 与环的防御", () => {
  const raw = Object.freeze({ type: "future" as const });
  const root = Object.freeze({ recognition: "unknown" as const, type: "future", id: "root", parentId: null, timestamp: timestamp(1), raw });
  const cycleA = Object.freeze({ recognition: "unknown" as const, type: "future", id: "a", parentId: "b", timestamp: timestamp(2), raw });
  const cycleB = Object.freeze({ recognition: "unknown" as const, type: "future", id: "b", parentId: "a", timestamp: timestamp(3), raw });

  assert.deepEqual(buildActiveBranch([root]).map((item) => item.id), ["root"]);
  assert.throws(() => buildActiveBranch([root, cycleA, cycleB]), errorCode("cycle"));
  assert.throws(() => buildActiveBranch([root, cycleA]), errorCode("missing-parent"));
});

test("compaction firstKeptEntryId 必须是所有分支上的严格祖先", async (t) => {
  const accepted = await writeSession(t, [
    header(),
    user("u1", null, 1),
    entry("compaction", "c1", "u1", 2, { summary: "summary", firstKeptEntryId: "u1", tokensBefore: 42 }),
  ]);
  const invalidCases: readonly [string, readonly unknown[]][] = [
    ["missing", [
      header(),
      user("u1", null, 1),
      entry("compaction", "c1", "u1", 2, { summary: "summary", firstKeptEntryId: "missing", tokensBefore: 42 }),
    ]],
    ["self", [
      header(),
      user("u1", null, 1),
      entry("compaction", "c1", "u1", 2, { summary: "summary", firstKeptEntryId: "c1", tokensBefore: 42 }),
    ]],
    ["sibling", [
      header(),
      user("u1", null, 1),
      user("sibling", "u1", 2),
      user("active", "u1", 3),
      entry("compaction", "c1", "active", 4, { summary: "summary", firstKeptEntryId: "sibling", tokensBefore: 42 }),
    ]],
    ["abandoned", [
      header(),
      user("u1", null, 1),
      entry("compaction", "abandoned", "u1", 2, { summary: "summary", firstKeptEntryId: "missing", tokensBefore: 42 }),
      user("active", "u1", 3),
    ]],
  ];
  const retainedTailOnly = await writeSession(t, [
    header(),
    entry("compaction", "c1", null, 1, { summary: "summary", tokensBefore: 42, retainedTail: [] }),
  ]);

  assert.equal((await loadSourceSnapshot(accepted)).entries.at(-1)?.id, "c1");
  for (const [, values] of invalidCases) {
    await assert.rejects(loadSourceSnapshot(await writeSession(t, values)), errorCode("invalid-tree"));
  }
  await assert.rejects(loadSourceSnapshot(retainedTailOnly), errorCode("invalid-entry"));
});
