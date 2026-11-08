import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCommand } from "../src/executor.ts";
import { definition, eventually } from "./helpers.ts";

async function fixturePid(file: string): Promise<number | undefined> {
  if (!existsSync(file)) return undefined;
  const pid = Number(await readFile(file, "utf8"));
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

async function reapFixture(file: string): Promise<void> {
  const pid = await fixturePid(file);
  if (!pid) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* fixture 已退出。 */ }
}

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
  assert.ok(Date.now() - started < (process.platform === "win32" ? 5_000 : 3_000));
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

test("parent exit reaps POSIX descendants or bounds Windows inherited pipes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "monitor-child-"));
  const pidFile = path.join(directory, "child.pid");
  try {
    const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr]});fs.writeFileSync(${JSON.stringify(pidFile)},String(p.pid));console.log('ok');process.exit(0)`;
    const started = Date.now();
    const promise = runCommand(definition({ args: ["-e", script], timeoutMs: 5_000 }), new AbortController().signal);
    if (process.platform === "win32") {
      // 继承管道在 Windows 上的收口时序允许两种结果；其他错误仍必须暴露。
      const outcome = await promise.then((stdout) => ({ stdout: stdout.trim() }), (error: Error) => ({ error }));
      if ("stdout" in outcome) assert.equal(outcome.stdout, "ok");
      else assert.match(outcome.error.message, /输出管道未关闭/);
      assert.ok(Date.now() - started < 4_000);
    } else {
      assert.equal((await promise).trim(), "ok");
      const pid = await fixturePid(pidFile);
      assert.ok(pid, "fixture 必须记录有效子进程 PID");
      await eventually(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    }
  } finally {
    await reapFixture(pidFile);
    await rm(directory, { recursive: true, force: true });
  }
});

test("abort reaps a running check's descendant tree", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "monitor-abort-child-"));
  const pidFile = path.join(directory, "child.pid");
  const controller = new AbortController();
  try {
    const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});fs.writeFileSync(${JSON.stringify(pidFile)},String(p.pid));setInterval(()=>{},1000)`;
    const result = runCommand(definition({ args: ["-e", script], timeoutMs: 10_000 }), controller.signal).then(() => null, (error: Error) => error);
    await eventually(async () => (await fixturePid(pidFile)) !== undefined, 5_000);
    controller.abort();
    assert.match((await result)?.message ?? "", /取消/);
    const pid = await fixturePid(pidFile);
    assert.ok(pid, "fixture 必须记录有效子进程 PID");
    await eventually(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 3_000);
  } finally {
    controller.abort();
    await reapFixture(pidFile);
    await rm(directory, { recursive: true, force: true });
  }
});

test("stdout and stderr share a byte limit", async () => {
  await assert.rejects(runCommand(definition({ args: ["-e", "process.stdout.write('a'.repeat(40000));process.stderr.write('b'.repeat(40000));setInterval(()=>{},1000)"] }), new AbortController().signal), /stdout 与 stderr 合计/);
});

test("Windows resolves cmd wrappers and shebangs without losing argv", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "monitor 中文 space-"));
  try {
    const script = path.join(directory, "check.cjs");
    const wrapper = path.join(directory, "check.cmd");
    const batch = path.join(directory, "check.bat");
    const shebang = path.join(directory, "shebang-check");
    await writeFile(script, "console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}))");
    const wrapperSource = `@"${process.execPath}" "%~dp0check.cjs" %*\r\n`;
    await writeFile(wrapper, wrapperSource);
    await writeFile(batch, wrapperSource);
    await writeFile(shebang, "#!node\n" + await readFile(script, "utf8"));
    await chmod(shebang, 0o755);
    const args = ["空 格", "a&b", "quoted \"value\"", "a|b", "(parentheses)"];
    for (const command of [wrapper, batch, shebang, "check"]) {
      const output = JSON.parse(await runCommand(definition({ command, args, cwd: directory, timeoutMs: 5_000 }), new AbortController().signal));
      assert.deepEqual(output.args, args);
      assert.equal(output.cwd, directory);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
