import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { eventually, piCliPath } from "./helpers.ts";

// 仅本地 HTTP fixture 伪造模型响应，真实 Pi 驱动解释轮和工具硬门禁；没有外部模型费用。
test("real Pi explanation persists receipt and blocks model-requested writes", { timeout: 30_000 }, async (t) => {
  const cli = piCliPath();
  if (!cli) {
    t.skip("需要可用的 Pi CLI；可用 PI_MONITOR_PI_ROOT 指定 package 根目录");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "monitor-explain-"));
  const agent = path.join(root, "agent");
  await mkdir(agent);
  const trap = path.join(root, "must-not-exist.txt");
  const requests: any[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const base = { id: `fixture-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "fixture" };
      const chunk = (delta: unknown, finish_reason: string | null) => response.write("data: " + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] }) + "\n\n");
      if (requests.length === 1) {
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: "forbidden-write", type: "function", function: { name: "write", arguments: JSON.stringify({ path: trap, content: "must be blocked" }) } }] }, null);
        chunk({}, "tool_calls");
      } else {
        chunk({ role: "assistant", content: "监听结果已解释，未执行后续操作。" }, null);
        chunk({}, "stop");
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const provider = path.join(root, "provider.ts");
  await writeFile(provider, `export default function(pi){pi.registerProvider('monitor-fixture',{baseUrl:'http://127.0.0.1:${address.port}/v1',apiKey:'fixture-only',api:'openai-completions',models:[{id:'fixture',name:'fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:4096}]});}`);
  const session = path.join(root, "session.jsonl");
  await writeFile(session, [
    { type: "session", version: 3, id: "explain-owner", timestamp: new Date().toISOString(), cwd: root },
    { type: "message", id: "seed", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "离线测试基线", timestamp: Date.now() } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const child = spawn(process.execPath, [cli, "--offline", "--mode", "rpc", "--session", session,
    "-ne", "-ns", "-np", "-nc", "--no-themes", "--no-mcp", "-e", fileURLToPath(new URL("../index.ts", import.meta.url)), "-e", provider,
    "--provider", "monitor-fixture", "--model", "fixture", "--thinking", "off",
  ], { cwd: root, env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", TERM: "xterm-256color" }, stdio: ["pipe", "pipe", "pipe"] });
  let exited = false;
  const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => { exited = true; resolve(code); }));
  t.after(async () => {
    child.stdin.end();
    const force = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 2_000);
    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    clearTimeout(force);
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const events: any[] = [];
  let buffer = "";
  let diagnostics = "";
  child.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-4_000); });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      end = buffer.indexOf("\n");
      if (!line.trim()) continue;
      const event = JSON.parse(line); events.push(event);
    }
  });
  async function command(id: string, type: string, params: Record<string, unknown> = {}) {
    child.stdin.write(JSON.stringify({ id, type, ...params }) + "\n");
    await eventually(() => events.some((event) => event.id === id && event.type === "response") || exited, 15_000);
    const result = events.find((event) => event.id === id && event.type === "response");
    assert.ok(result, diagnostics); assert.equal(result.success, true, JSON.stringify(result));
    return result.data;
  }
  await command("start", "prompt", { message: "/monitor start " + JSON.stringify({ name: "自动解释", purpose: "解释本地测试结果", mode: "once", delivery: "explain", command: process.execPath, args: ["-e", "console.log(JSON.stringify({state:'ok',events:[{id:'done',summary:'检查成功',data:{value:42}}]}))"] }) });
  await eventually(() => events.some((event) => event.type === "agent_settled") || exited, 15_000);
  assert.equal(requests.length, 2, diagnostics + JSON.stringify(events.filter((event) => event.type === "extension_error")));
  assert.equal(events.some((event) => event.method === "confirm"), false);
  assert.equal(events.some((event) => event.type === "extension_error"), false);
  assert.equal(existsSync(trap), false);
  assert.ok(requests[1].messages.some((message: any) => message.role === "tool" && JSON.stringify(message).includes("本轮由监听结果触发")));
  const data = await command("entries", "get_entries");
  assert.equal(data.entries.filter((entry: any) => entry.type === "custom_message" && entry.customType === "monitor-result").length, 1);
  const states = data.entries.filter((entry: any) => entry.type === "custom" && entry.customType === "monitor-state");
  assert.equal(states.at(-1).data.record.pending.length, 0);
  assert.equal(states.at(-1).data.record.status, "completed");
  assert.ok(events.some((event) => event.type === "message_end" && event.message?.role === "assistant" && JSON.stringify(event.message.content).includes("监听结果已解释")));
  child.stdin.end(); assert.equal(await exit, 0);
});
