import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runCommand } from "../src/executor.ts";
import { terminateWindowsTree, type ProcessBackend } from "../src/process-backend.ts";
import { definition } from "./helpers.ts";

function childFixture() {
  const kills: Array<NodeJS.Signals | number | undefined> = [];
  let unrefs = 0;
  const child = Object.assign(new EventEmitter(), {
    pid: 42, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: (signal?: NodeJS.Signals | number) => { kills.push(signal); return true; },
    unref: () => { unrefs++; },
  });
  return { child, process: child as unknown as ChildProcessWithoutNullStreams, kills, unrefs: () => unrefs };
}

test("Windows tree cleanup uses a system executable and separated arguments", async () => {
  const root = childFixture();
  const killer = childFixture();
  const cleanup = terminateWindowsTree(root.process, (command, args) => {
    assert.equal(command, "D:\\Windows\\System32\\taskkill.exe");
    assert.deepEqual(args, ["/T", "/F", "/PID", "42"]);
    queueMicrotask(() => killer.child.emit("exit", 0));
    return killer.process;
  }, 100, "D:\\Windows");
  await cleanup;
});

test("Windows never invokes taskkill with an already exited root PID", async () => {
  const root = childFixture();
  root.child.exitCode = 0;
  await terminateWindowsTree(root.process, () => { throw new Error("must not spawn"); });
  root.child.exitCode = null;
  root.child.signalCode = "SIGKILL";
  await terminateWindowsTree(root.process, () => { throw new Error("must not spawn"); });
});

test("Windows cleanup reports spawn errors, nonzero exit and a bounded timeout", async () => {
  const root = childFixture();
  await assert.rejects(terminateWindowsTree(root.process, () => { throw new Error("unavailable"); }), /无法启动/);
  const missing = childFixture();
  await assert.rejects(terminateWindowsTree(root.process, () => {
    queueMicrotask(() => missing.child.emit("error", new Error("ENOENT")));
    return missing.process;
  }), /无法启动/);
  const denied = childFixture();
  await assert.rejects(terminateWindowsTree(root.process, () => {
    queueMicrotask(() => denied.child.emit("exit", 5));
    return denied.process;
  }), /退出码 5/);
  const stuck = childFixture();
  await assert.rejects(terminateWindowsTree(root.process, () => stuck.process, 10), /清理超时/);
  assert.deepEqual(stuck.kills, ["SIGKILL"]);
  assert.equal(stuck.unrefs(), 1);
  // 终止后迟到的错误也必须被消费。
  stuck.child.emit("error", new Error("late failure"));
});

test("Windows inherited pipes settle without retrying an exited PID", async () => {
  const root = childFixture();
  let stops = 0;
  const diagnostics: string[] = [];
  const backend: ProcessBackend = {
    platform: "win32",
    start: () => {
      queueMicrotask(() => {
        root.child.stdout.write("ok");
        root.child.exitCode = 0;
        root.child.emit("exit", 0, null);
      });
      return root.process;
    },
    stop: () => { stops++; },
  };
  const controller = new AbortController();
  const started = Date.now();
  await assert.rejects(runCommand(definition(), controller.signal, { backend, onDiagnostic: (message) => diagnostics.push(message) }), /输出管道未关闭/);
  assert.ok(Date.now() - started < 3_000);
  assert.equal(stops, 0);
  assert.equal(root.child.stdout.destroyed, true);
  assert.equal(root.child.stderr.destroyed, true);
  assert.equal(root.child.listenerCount("exit"), 0);
  assert.equal(root.child.listenerCount("close"), 0);
  controller.abort();
  assert.equal(stops, 0);
  assert.equal(diagnostics.length, 1);
});

test("Windows cleanup failure warns and settles while preserving cancellation", async () => {
  const root = childFixture();
  const diagnostics: string[] = [];
  let stops = 0;
  const backend: ProcessBackend = {
    platform: "win32", start: () => root.process,
    stop: async () => { stops++; throw new Error("taskkill failed; descendants may remain"); },
  };
  root.child.kill = (signal) => {
    root.kills.push(signal);
    queueMicrotask(() => {
      root.child.signalCode = "SIGKILL";
      root.child.emit("exit", null, "SIGKILL");
      root.child.emit("close", null, "SIGKILL");
    });
    return true;
  };
  const controller = new AbortController();
  const result = runCommand(definition(), controller.signal, { backend, onDiagnostic: (message) => diagnostics.push(message) });
  controller.abort();
  await assert.rejects(result, /取消/);
  assert.equal(stops, 1);
  assert.deepEqual(root.kills, ["SIGKILL"]);
  assert.match(diagnostics[0], /taskkill failed/);
});

test("Windows returns within a bound even if a stopped root never reports exit", async () => {
  const root = childFixture();
  const diagnostics: string[] = [];
  let stops = 0;
  const backend: ProcessBackend = { platform: "win32", start: () => root.process, stop: () => { stops++; } };
  const controller = new AbortController();
  const started = Date.now();
  const result = runCommand(definition(), controller.signal, { backend, onDiagnostic: (message) => diagnostics.push(message) });
  controller.abort();
  await assert.rejects(result, /取消/);
  assert.ok(Date.now() - started < 5_000);
  assert.equal(stops, 1);
  assert.match(diagnostics[0], /未能确认退出/);
  assert.equal(root.child.stdin.destroyed, true);
  assert.equal(root.child.stdout.destroyed, true);
  assert.equal(root.child.stderr.destroyed, true);
});

test("already aborted commands never invoke the backend", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runCommand(definition(), controller.signal, {
    backend: { platform: "win32", start: () => { throw new Error("must not start"); }, stop: () => {} },
  }), /取消/);
});
