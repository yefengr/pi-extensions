import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { eventually, installedPiRoot } from "./helpers.ts";

// 隔离 HOME/agent 目录且仅使用 notify，不读取真实认证、不发起模型请求。
test("real RPC: start/resume without confirmation, once/continuous, reload and session isolation", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "monitor-rpc-"));
  const agent = path.join(root, "agent");
  await mkdir(agent);
  const counter = path.join(root, "counter.json");
  const script = path.join(root, "check.mjs");
  await writeFile(script, `import fs from 'node:fs';const file=${JSON.stringify(counter)};const n=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8'))+1:1;fs.writeFileSync(file,JSON.stringify(n));console.log(JSON.stringify({state:'ok',events:[{id:String(n),summary:'检查事件 '+n}],cursor:String(n)}));`);
  const session = path.join(root, "seed-session.jsonl");
  await writeFile(session, [
    { type: "session", version: 3, id: "monitor-smoke-owner", timestamp: new Date().toISOString(), cwd: root },
    { type: "message", id: "seed-user", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "离线监听测试基线", timestamp: Date.now() } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const reload = path.join(root, "reload.ts");
  await writeFile(reload, "export default function(pi){pi.registerCommand('monitor-test-reload',{description:'test-only reload',handler:async(_args,ctx)=>{await ctx.reload();}})}");
  const child = spawn(process.execPath, [
    path.join(installedPiRoot(), "dist", "cli.js"), "--offline", "--mode", "rpc", "--session", session,
    "-ne", "-ns", "-np", "-nc", "--no-themes", "--no-mcp", "-e",
    fileURLToPath(new URL("../index.ts", import.meta.url)), "-e", reload,
  ], { cwd: root, env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", TERM: "xterm-256color" }, stdio: ["pipe", "pipe", "pipe"] });
  const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
  let exited = false;
  child.once("exit", () => { exited = true; });
  t.after(async () => {
    child.stdin.end();
    const force = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 2_000);
    await exit; clearTimeout(force);
    await rm(root, { recursive: true, force: true });
  });
  const events: any[] = [];
  let buffer = "";
  let diagnostics = "";
  let parseError: unknown;
  let sequence = 0;
  child.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-4_000); });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, ""); buffer = buffer.slice(end + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line); events.push(event);
      } catch (error) { parseError = error; }
    }
  });
  async function command(type: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = `request-${++sequence}`;
    child.stdin.write(JSON.stringify({ id, type, ...params }) + "\n");
    await eventually(() => events.some((event) => event.type === "response" && event.id === id) || exited, 15_000);
    const response = events.find((event) => event.type === "response" && event.id === id);
    assert.ok(response, `Pi exited before response: ${diagnostics}`);
    assert.equal(response.success, true, JSON.stringify(response));
    assert.equal(parseError, undefined);
    return response.data;
  }
  const start = (mode: string) => command("prompt", { message: "/monitor start " + JSON.stringify({ name: `RPC ${mode}`, purpose: "smoke 事件", mode, delivery: "notify", command: process.execPath, args: [script], intervalSeconds: 1 }) });
  async function states() {
    const data = await command("get_entries");
    const tasks = new Map<string, any>();
    for (const entry of data.entries) if (entry.type === "custom" && entry.customType === "monitor-state") tasks.set(entry.data.record.id, entry.data.record);
    return [...tasks.values()];
  }
  const commands = await command("get_commands");
  assert.ok(commands.commands.some((item: any) => item.name === "monitor"));
  await start("once");
  await eventually(() => events.some((event) => event.method === "notify" && event.message.includes("个新事件")), 5_000);
  let tasks = await states();
  assert.equal(tasks[0].status, "completed");
  assert.equal(tasks[0].pending.length, 0);
  const logDir = path.join(root, ".pi", "logs", "monitor");
  let logFiles: string[] = [];
  for (let attempt = 0; attempt < 100 && !logFiles.length; attempt++) {
    logFiles = await readdir(logDir).catch(() => []);
    if (!logFiles.length) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(logFiles.length, 1);
  const logged = (await readFile(path.join(logDir, logFiles[0]), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(logged.some((entry) => entry.action === "start"));
  assert.ok(logged.some((entry) => entry.action === "check" && entry.events?.[0]?.summary.startsWith("检查事件")));
  await start("continuous");
  await eventually(() => events.filter((event) => event.method === "notify" && event.message.includes("个新事件")).length >= 3, 5_000);
  tasks = await states();
  const continuous = tasks.find((task) => task.mode === "continuous");
  assert.equal(continuous.status, "running");
  const before = await command("get_state");
  await command("prompt", { message: "/monitor-test-reload" });
  tasks = await states();
  assert.equal(tasks.find((task) => task.id === continuous.id).status, "running");
  assert.ok(events.some((event) => event.method === "setStatus" && event.statusKey === "monitor" && event.statusText?.includes("运行 1")));
  await command("new_session");
  assert.equal((await states()).length, 0);
  await start("once");
  assert.equal(events.some((event) => event.method === "confirm"), false);
  assert.ok(events.some((event) => event.method === "notify" && event.message.includes("尚未落盘")));
  assert.equal((await states()).length, 0);
  const pausedCounter = await readFile(counter, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(await readFile(counter, "utf8"), pausedCounter);
  await command("switch_session", { sessionPath: before.sessionFile });
  tasks = await states();
  assert.equal(tasks.find((task) => task.id === continuous.id).status, "paused");
  await command("prompt", { message: `/monitor resume ${continuous.id}` });
  tasks = await states();
  assert.equal(tasks.find((task) => task.id === continuous.id).status, "running");
  assert.equal(events.some((event) => event.method === "confirm"), false);
  await command("prompt", { message: `/monitor stop ${continuous.id}` });
  assert.equal((await states()).find((task) => task.id === continuous.id).status, "stopped");
  assert.equal(events.some((event) => event.type === "agent_start"), false);
  assert.equal(events.some((event) => event.type === "message_start" && event.message?.role === "assistant"), false);
  const messages = await command("get_messages");
  assert.equal(messages.messages.some((message: any) => message.role === "custom" && message.customType === "monitor-result"), false);
  child.stdin.end();
  assert.equal(await exit, 0);
});
