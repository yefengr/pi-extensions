import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const extension = process.env.EXTENSION;
const piPackage = process.env.PI_PACKAGE;
if (!extension || !piPackage) throw new Error("缺少 EXTENSION 或 PI_PACKAGE");
const fixture = mkdtempSync(path.join(tmpdir(), "worktree-auto-switch-e2e-"));
const repo = path.join(fixture, "repo");
const agentDir = path.join(fixture, "agent");
const sessionDir = path.join(fixture, "sessions");
const sourceSession = path.join(fixture, "source.jsonl");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
const targetName = "auto-e2e";
const targetBranch = "feat/auto-e2e";
const prompt = "创建独立工作空间，然后在新工作空间检查实际目录并继续原任务。";
const completion = "fixture continuation completed";
const requests = [];
let rpc;
let serverError;

// 仅监听回环地址，用固定的合成响应驱动真实 Pi；不访问模型服务或使用真实凭据。
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push(parsed);
    const step = requests.length;
    assert.ok(step <= 3, `自动继续重复触发模型：第 ${step} 次请求`);
    const delta = step === 1
      ? toolDelta("fixture-create", "worktree_create", {
          name: targetName, mode: "new-branch", baseRef: "main", branch: targetBranch,
        })
      : step === 2
        ? toolDelta("fixture-pwd", "bash", {
            command: "pwd; git rev-parse --show-toplevel; git branch --show-current",
          })
        : { role: "assistant", content: completion };
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const frame = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    frame({
      id: `fixture-${step}`, object: "chat.completion.chunk", created: 1, model: "fixture",
      choices: [{ index: 0, delta, finish_reason: null }],
    });
    frame({
      id: `fixture-${step}`, object: "chat.completion.chunk", created: 1, model: "fixture",
      choices: [{ index: 0, delta: {}, finish_reason: step < 3 ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    response.end("data: [DONE]\n\n");
  } catch (error) {
    serverError = error;
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: String(error) } }));
  }
});

async function main() {
  for (const directory of [repo, agentDir, sessionDir]) mkdirSync(directory);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "fixture");
  git(repo, "config", "user.email", "fixture@example.invalid");
  writeFileSync(path.join(repo, "README.md"), "isolated synthetic fixture\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "fixture");
  const sourceCwd = realpathSync(repo);
  const targetCwd = path.join(realpathSync(fixture), "worktrees", targetName);
  writeFileSync(sourceSession, `${JSON.stringify({
    type: "session", version: 3, id: "33333333-3333-7333-8333-333333333333",
    timestamp: "2026-01-01T00:00:00.000Z", cwd: sourceCwd,
  })}\n`);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "worktree-fixture": {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        api: "openai-completions", apiKey: "isolated-fixture-only",
        models: [{
          id: "fixture", name: "fixture", reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000, maxTokens: 4096,
        }],
      },
    },
  }));
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    compaction: { enabled: false }, retry: { enabled: false },
  }));
  rpc = new RpcClient(sourceCwd);
  const completed = rpc.waitFor((record, records) => record.type === "agent_settled"
    && records.some((item) => item.type === "message_end"
      && item.message?.role === "assistant" && textOf(item.message.content).includes(completion)));
  const initialPrompt = rpc.request("prompt", { message: prompt });
  await deadline(Promise.all([initialPrompt, completed]), 45000, "自动切换及继续任务");
  if (serverError) throw serverError;

  const state = await rpc.request("get_state");
  const migratedFile = state.data.sessionFile;
  assert.ok(migratedFile && migratedFile !== sourceSession, "模型创建后未自动切换持久会话");
  const entries = jsonLines(migratedFile);
  assert.equal(realpathSync(entries[0].cwd), realpathSync(targetCwd));
  assert.equal(entries[0].parentSession, sourceSession);
  assert.equal(git(targetCwd, "branch", "--show-current").trim(), targetBranch);
  const creation = entries.find((entry) => entry.type === "message"
    && entry.message.role === "toolResult" && entry.message.toolName === "worktree_create");
  assert.equal(creation?.message.details?.migrationStatus, "scheduled");
  assert.equal(creation.message.isError, false);
  const pwd = entries.find((entry) => entry.type === "message"
    && entry.message.role === "toolResult" && entry.message.toolName === "bash");
  assert.ok(pwd && !pwd.message.isError, "自动迁移后未继续执行内置 bash");
  assert.equal(textOf(pwd.message.content).trim(), `${realpathSync(targetCwd)}\n${realpathSync(targetCwd)}\n${targetBranch}`);
  const humanMessages = entries.filter((entry) => entry.type === "message" && entry.message.role === "user");
  assert.equal(humanMessages.length, 1, "自动交接不应伪造人类输入");
  assert.ok(textOf(humanMessages[0].message.content).includes(prompt));
  const continuations = entries.filter((entry) => entry.type === "custom_message"
    && entry.customType === "worktree:message" && textOf(entry.content).includes("继续"));
  assert.equal(continuations.length, 1, "自动交接必须仅触发一次扩展继续消息");
  assert.equal(requests.length, 3);
  assert.ok(JSON.stringify(requests[1].messages).includes(targetCwd), "继续任务请求缺少新目录上下文");
  assert.ok(rpc.records.some((record) => record.method === "notify"
    && textOf(record.message).includes(targetCwd)), "未收到新会话目录验证后的成功通知");
  const footerAfterAuto = await renderFooter(migratedFile, targetBranch);
  assert.ok(footerAfterAuto.includes(targetCwd), `默认状态栏未显示目标目录：${footerAfterAuto}`);
  assert.ok(footerAfterAuto.includes(targetBranch));

  // JSON 仅用于 RPC 自动验证；用户入口由无参命令/快捷键打开选择列表。
  await rpc.request("prompt", { message: `/worktree:switch ${JSON.stringify({
    repoPath: sourceCwd, worktreePath: sourceCwd,
  })}` });
  const back = await rpc.request("get_state");
  assert.notEqual(back.data.sessionFile, migratedFile, "无法从工作树返回主工作区");
  const backHeader = jsonLines(back.data.sessionFile)[0];
  assert.equal(realpathSync(backHeader.cwd), sourceCwd);
  assert.equal(backHeader.parentSession, migratedFile);
  const footerAfterBack = await renderFooter(back.data.sessionFile, "main");
  assert.ok(footerAfterBack.includes(sourceCwd));
  assert.equal(requests.length, 3, "手动切换不应触发模型");
  await rpc.request("prompt", { message: `/worktree:switch ${JSON.stringify({
    repoPath: sourceCwd, worktreePath: sourceCwd,
  })}` });
  const unchanged = await rpc.request("get_state");
  assert.equal(unchanged.data.sessionFile, back.data.sessionFile, "选择当前工作区不应重复 fork");
  console.log(JSON.stringify({
    result: "passed", modelRequests: requests.length, automaticContinuation: true,
    builtInToolCwd: "target worktree", footerAfterAuto, footerAfterBack,
    sameWorkspace: "no-op", manualSwitchModelRequests: 0,
  }, null, 2));
}

async function cleanup() {
  await rpc?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(fixture, { recursive: true, force: true });
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function jsonLines(file) {
  return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function textOf(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((block) => block.type === "text").map((block) => block.text).join("\n") : "";
}

function toolDelta(id, name, args) {
  return { role: "assistant", tool_calls: [{
    index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) },
  }] };
}

async function renderFooter(sessionFile, branch) {
  const { SessionManager } = await import(pathToFileURL(piPackage).href);
  const { FooterComponent } = await import(pathToFileURL(path.join(
    path.dirname(piPackage), "modes", "interactive", "components", "footer.js",
  )).href);
  const themeModule = await import(pathToFileURL(path.join(
    path.dirname(piPackage), "modes", "interactive", "theme", "theme.js",
  )).href);
  themeModule.initTheme("dark", false);
  const sessionManager = SessionManager.open(sessionFile);
  const session = {
    sessionManager, state: {}, getContextUsage: () => undefined,
    modelRuntime: { isUsingSubscription: () => false },
  };
  const footer = new FooterComponent(session, {
    getGitBranch: () => branch, getAvailableProviderCount: () => 1,
    getExtensionStatuses: () => new Map(),
  });
  return footer.render(4096)[0].replace(/\x1b\[[0-9;]*m/g, "");
}

function deadline(promise, timeoutMs, label) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label}超时\n${rpc?.diagnostics() ?? ""}`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

class RpcClient {
  records = [];
  pending = new Map();
  watchers = new Set();
  nextId = 0;
  buffer = "";
  stderr = "";
  closed = false;

  constructor(cwd) {
    this.child = spawn(process.execPath, [
      process.env.PI_CLI,
      "--mode", "rpc", "--offline", "--provider", "worktree-fixture", "--model", "fixture",
      "--thinking", "off", "--session", sourceSession, "--session-dir", sessionDir,
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "-e", extension,
    ], {
      cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessionDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.child.stdout.on("data", (chunk) => this.receive(chunk.toString()));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("close", (code) => {
      this.closed = true;
      this.fail(new Error(`Pi 已退出 ${code}\n${this.diagnostics()}`));
    });
  }

  request(type, args = {}) {
    const id = `request-${++this.nextId}`;
    return deadline(new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, type, ...args })}\n`);
    }), 15000, type);
  }

  waitFor(predicate) {
    return new Promise((resolve, reject) => {
      const matched = this.records.find((record) => predicate(record, this.records));
      if (matched) resolve(matched);
      else this.watchers.add({ predicate, resolve, reject });
    });
  }

  receive(chunk) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); }
      catch (error) { this.fail(new Error(`非法 RPC 输出：${line.slice(0, 500)}`, { cause: error })); return; }
      this.records.push(record);
      if (record.type === "response" && this.pending.has(record.id)) {
        const pending = this.pending.get(record.id);
        this.pending.delete(record.id);
        if (record.success) pending.resolve(record);
        else pending.reject(new Error(`RPC 请求失败：${JSON.stringify(record)}`));
      }
      for (const watcher of this.watchers) {
        if (!watcher.predicate(record, this.records)) continue;
        this.watchers.delete(watcher);
        watcher.resolve(record);
      }
    }
  }

  fail(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const watcher of this.watchers) watcher.reject(error);
    this.watchers.clear();
  }

  diagnostics() {
    return `${this.stderr.slice(-4000)}\n${this.records.slice(-8).map((record) => JSON.stringify(record)).join("\n")}`;
  }

  async close() {
    if (this.closed) return;
    const done = once(this.child, "close");
    this.child.kill("SIGTERM");
    const force = setTimeout(() => this.child.kill("SIGKILL"), 1500);
    try { await done; }
    finally { clearTimeout(force); }
  }
}

try {
  await main();
} finally {
  await cleanup();
}
