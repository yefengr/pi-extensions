import assert from "node:assert/strict";
import test from "node:test";
import { parseCheckResult } from "../src/protocol.ts";

test("protocol accepts empty, multi-event, cursor and checker error", () => {
  assert.deepEqual(parseCheckResult('{"state":"ok","events":[]}'), { state: "ok", events: [] });
  assert.deepEqual(parseCheckResult(JSON.stringify({ state: "ok", cursor: "page-2", events: [{ id: "a", summary: "阶段一", data: { value: 1 } }, { id: "b", summary: "阶段二" }, { id: "a", summary: "重复" }] })), {
    state: "ok", cursor: "page-2", events: [{ id: "a", summary: "阶段一", data: { value: 1 } }, { id: "b", summary: "阶段二" }],
  });
  assert.deepEqual(parseCheckResult('{"state":"error","summary":"接口异常"}'), { state: "error", summary: "接口异常" });
});

test("protocol rejects malformed, unknown fields and oversized data", () => {
  for (const value of ["log\n{}", "{}{}", "[]", "null", '{"state":"ready"}', '{"state":"ok"}', '{"state":"ok","events":[],"typo":true}', '{"state":"error","summary":""}']) {
    assert.throws(() => parseCheckResult(value));
  }
  for (const event of [{ id: "", summary: "x" }, { id: 1, summary: "x" }, { id: "a", summary: "" }, { id: "a", summary: "x", extra: 1 }, { id: "a", summary: "x", data: "x".repeat(9_000) }]) {
    assert.throws(() => parseCheckResult(JSON.stringify({ state: "ok", events: [event] })));
  }
  assert.throws(() => parseCheckResult(JSON.stringify({ state: "ok", events: [], cursor: null })));
  assert.throws(() => parseCheckResult(JSON.stringify({ state: "ok", events: Array.from({ length: 33 }, (_, n) => ({ id: `${n}`, summary: "x" })) })));
  assert.throws(() => parseCheckResult(" ".repeat(70_000)));
});
