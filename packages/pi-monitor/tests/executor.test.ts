import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCommand } from "../src/executor.ts";
import { definition } from "./helpers.ts";

test("runner uses cwd/argv, supplies JSON stdin and separates stderr", async () => {
  const task = definition({ args: ["-e", "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{console.error('diagnostic');console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1),input:JSON.parse(s)}))})", "literal $(no-shell)"], timeoutMs: 2_000 });
  const output = JSON.parse(await runCommand({ ...task, cursor: "cursor-1" }, new AbortController().signal));
  assert.equal(output.cwd, task.cwd);
  assert.deepEqual(output.args, ["literal $(no-shell)"]);
  assert.deepEqual(output.input, { monitorId: task.id, cursor: "cursor-1" });
});

test("nonzero exit, launch error and output flood fail", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(runCommand(definition({ args: ["-e", "console.error('bad');process.exit(3)"] }), signal), /退出：3；bad/);
  await assert.rejects(runCommand(definition({ command: "/missing/monitor-command" }), signal), /无法启动/);
  await assert.rejects(runCommand(definition({ args: ["-e", "process.stdout.write('a'.repeat(200000));setInterval(()=>{},1000)"] }), signal), /输出超过/);
});

test("timeout escalates even when SIGTERM is ignored", async () => {
  const started = Date.now();
  await assert.rejects(runCommand(definition({ args: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], timeoutMs: 250 }), new AbortController().signal), /超时/);
  assert.ok(Date.now() - started < 3_000);
});

test("abort and already aborted never leave a check running", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runCommand(definition(), controller.signal), /取消/);
  const active = new AbortController();
  const promise = runCommand(definition({ args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 5_000 }), active.signal);
  setTimeout(() => active.abort(), 50);
  await assert.rejects(promise, /取消/);
});

test("parent exit reaps descendants inheriting stdout", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "monitor-child-"));
  const pidFile = path.join(directory, "child.pid");
  try {
    const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr]});fs.writeFileSync(${JSON.stringify(pidFile)},String(p.pid));console.log('ok');process.exit(0)`;
    const output = await runCommand(definition({ args: ["-e", script], timeoutMs: 2_000 }), new AbortController().signal);
    assert.equal(output.trim(), "ok");
    const pid = Number(await readFile(pidFile, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
