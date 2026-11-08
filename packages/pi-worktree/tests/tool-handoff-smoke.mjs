import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { FIXTURE: fixture, EXTENSION: extensionPath, PI_PACKAGE: piPackage } = process.env;
if (!fixture || !extensionPath || !piPackage) throw new Error("缺少 FIXTURE、EXTENSION 或 PI_PACKAGE");
const { discoverAndLoadExtensions } = await import(pathToFileURL(piPackage).href);
const repo = path.join(fixture, "repo");
const agentDir = path.join(fixture, "agent");
const sessionDir = path.join(fixture, "sessions");
const sourceSession = path.join(fixture, "source.jsonl");
mkdirSync(repo, { recursive: true });
mkdirSync(agentDir, { recursive: true });
mkdirSync(sessionDir, { recursive: true });
for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "tester"], ["config", "user.email", "tester@example.com"]]) git(repo, ...args);
writeFileSync(path.join(repo, "README.md"), "fixture\n");
git(repo, "add", "README.md");
git(repo, "commit", "-qm", "init");
const repoReal = realpathSync.native(repo);
writeFileSync(sourceSession, `${JSON.stringify({ type: "session", version: 3, id: "22222222-2222-7222-8222-222222222222", timestamp: "2026-08-12T00:00:00.000Z", cwd: repoReal })}\n`);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
const loaded = await discoverAndLoadExtensions([extensionPath], repoReal, path.join(fixture, "empty-agent-dir"));
assert.deepEqual(loaded.errors, []);
const extension = loaded.extensions[0];
const dispatches = [];
const messages = [];
const notices = [];
const continuations = [];
loaded.runtime.sendUserMessage = (...args) => dispatches.push(args);
loaded.runtime.sendMessage = (message) => messages.push(message);
const ctx = {
  cwd: repoReal, mode: "rpc", sessionManager: { getSessionFile: () => sourceSession },
  ui: { notify: (text) => notices.push(text) }, waitForIdle: async () => {},
  async switchSession(file, options) {
    const header = JSON.parse(readFileSync(file, "utf8").split("\n")[0]);
    assert.equal(header.parentSession, sourceSession);
    await emit("session_shutdown", {}, ctx);
    await options.withSession({
      cwd: header.cwd, ui: ctx.ui,
      sendMessage: async (...args) => continuations.push(args),
    });
    ctx.migratedFile = file;
    return { cancelled: false };
  },
};
assert.deepEqual([...extension.commands.keys()].sort(), ["worktree:create", "worktree:list", "worktree:migrate", "worktree:remove", "worktree:switch"]);
const createTool = extension.tools.get("worktree_create").definition;
const params = { repoPath: repoReal, name: "tool-handoff", mode: "new-branch", baseRef: "main", branch: "feat/tool-handoff" };
const result = await createTool.execute("create", params, undefined, undefined, ctx);
assert.equal(result.details.migrationStatus, "scheduled");
assert.equal(result.terminate, true);
assert.equal(ctx.migratedFile, undefined);
assert.match(result.content[0].text, /尚未切换.*自动切换/);
assert.ok(result.details.migrationCommand.startsWith("/worktree:migrate "));
await assert.rejects(() => createTool.execute("create-again", { ...params, name: "not-created", branch: "feat/not-created" }, undefined, undefined, ctx), /待完成/);
assert.equal(existsSync(path.join(fixture, "worktrees", "not-created")), false);
const gate = await emit("tool_call", { toolName: "bash", input: { command: "pwd" } }, ctx);
assert.equal(gate.block, true);
assert.equal(gate.terminate, true);
// 真实宿主在首次 settled 后消费命令；未消费的下一次 settled 由失效回归单独覆盖。
await emit("agent_settled", { aborted: false }, ctx);
assert.equal(dispatches.length, 1);
assert.deepEqual(dispatches[0][1], { expandPromptTemplates: true });
assert.equal(JSON.parse(dispatches[0][0].slice("/worktree:migrate ".length)).continueTask, true);
await extension.commands.get("worktree:migrate").handler(dispatches[0][0].slice("/worktree:migrate ".length), ctx);
assert.equal(messages.length, 0, JSON.stringify(messages));
assert.ok(ctx.migratedFile && ctx.migratedFile !== sourceSession);
const header = JSON.parse(readFileSync(ctx.migratedFile, "utf8").split("\n")[0]);
assert.equal(realpathSync.native(header.cwd), result.details.worktreePath);
assert.equal(continuations.length, 1);
assert.equal(continuations[0][0].customType, "worktree:message");
assert.ok(continuations[0][0].content.includes(result.details.worktreePath));
assert.deepEqual(continuations[0][1], { triggerTurn: true });
assert.ok(notices.some((text) => text.includes("feat/tool-handoff")));
await emit("agent_settled", { aborted: false }, ctx);
await emit("agent_settled", { aborted: false }, ctx);
assert.equal(dispatches.length, 1);
console.log(JSON.stringify({ migrationStatus: result.details.migrationStatus, targetCwd: header.cwd, migratedSessionFile: ctx.migratedFile, continuationCount: continuations.length }, null, 2));

async function emit(name, event, context) {
  let result;
  for (const handler of extension.handlers.get(name) ?? []) result = await handler(event, context);
  return result;
}
function git(cwd, ...args) { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }); }
