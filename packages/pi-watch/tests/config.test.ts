import assert from "node:assert/strict";
import test from "node:test";
import { makeDefinition } from "../src/config.ts";

const valid = { name: "测试", purpose: "等待构建结果", mode: "once", command: process.execPath };

test("start defaults, absolute deadline and exact args", () => {
  const task = makeDefinition({ ...valid, args: ["a b", "$(not-a-shell)"], maxDurationSeconds: 60 }, process.cwd(), "owner", 1_000);
  assert.equal(task.intervalMs, 30_000);
  assert.equal(task.timeoutMs, 10_000);
  assert.equal(task.deadlineAt, 61_000);
  assert.equal(task.ownerSessionId, "owner");
  assert.deepEqual(task.args, ["a b", "$(not-a-shell)"]);
});

test("mode required; timings and unknown fields rejected", () => {
  assert.throws(() => makeDefinition({ ...valid, mode: undefined }, process.cwd(), "owner"), /明确 mode/);
  for (const input of [{ intervalSeconds: 0 }, { timeoutSeconds: Infinity }, { maxDurationSeconds: -1 }, { typo: true }, { delivery: "bad" }, { args: [1] }]) {
    assert.throws(() => makeDefinition({ ...valid, ...input }, process.cwd(), "owner"));
  }
  const task = makeDefinition({ ...valid, mode: "continuous" }, process.cwd(), "owner");
  assert.equal(task.deadlineAt, undefined);
});

test("logLevel 默认 info，只接受 off/info/debug", () => {
  assert.equal(makeDefinition(valid, process.cwd(), "owner").logLevel, "info");
  assert.equal(makeDefinition({ ...valid, logLevel: "debug" }, process.cwd(), "owner").logLevel, "debug");
  assert.equal(makeDefinition({ ...valid, logLevel: "off" }, process.cwd(), "owner").logLevel, "off");
  assert.throws(() => makeDefinition({ ...valid, logLevel: "verbose" }, process.cwd(), "owner"), /logLevel/);
  assert.throws(() => makeDefinition({ ...valid, logLevel: 1 }, process.cwd(), "owner"), /logLevel/);
});

test("autoResume 默认不写字段，只接受布尔值", () => {
  assert.equal(makeDefinition(valid, process.cwd(), "owner").autoResume, undefined);
  assert.equal(makeDefinition({ ...valid, autoResume: true }, process.cwd(), "owner").autoResume, true);
  assert.equal(makeDefinition({ ...valid, autoResume: false }, process.cwd(), "owner").autoResume, undefined);
  assert.throws(() => makeDefinition({ ...valid, autoResume: "yes" }, process.cwd(), "owner"), /autoResume/);
});

test("common inline secrets rejected without echoing values", () => {
  for (const args of [["--token=example"], ["--password", "example"], ["https://user:example@host/path"], ["https://host/?api_key=example"]]) {
    assert.throws(() => makeDefinition({ ...valid, args }, process.cwd(), "owner"), (error: Error) => {
      assert.match(error.message, /明文凭据/);
      assert.doesNotMatch(error.message, /example/);
      return true;
    });
  }
});
