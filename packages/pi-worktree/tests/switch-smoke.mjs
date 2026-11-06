import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { FIXTURE: requestedFixture, EXTENSION: extensionPath, PI_PACKAGE: piPackage } = process.env;
if (!extensionPath || !piPackage) throw new Error("缺少 EXTENSION 或 PI_PACKAGE");
const fixture = requestedFixture ?? mkdtempSync(path.join(tmpdir(), "switch-smoke-"));
try {
const { discoverAndLoadExtensions } = await import(pathToFileURL(piPackage).href);
const repo = path.join(fixture, "repo");
const agentDir = path.join(repo, ".pi", "agent");
const sourceSession = path.join(fixture, "source.jsonl");
mkdirSync(repo, { recursive: true });
mkdirSync(agentDir, { recursive: true });
git(repo, "init", "-q", "-b", "main");
git(repo, "config", "user.name", "tester");
git(repo, "config", "user.email", "tester@example.com");
writeFileSync(path.join(repo, "README.md"), "fixture\n");
git(repo, "add", "README.md");
git(repo, "commit", "-qm", "init");
const main = realpathSync(repo);
writeFileSync(sourceSession, `${JSON.stringify({ type: "session", version: 3, id: "33333333-3333-7333-8333-333333333333", timestamp: "2026-08-12T00:00:00.000Z", cwd: main })}\n`);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(fixture, "sessions");
const loaded = await discoverAndLoadExtensions([extensionPath], main, path.join(fixture, "empty-agent"));
assert.deepEqual(loaded.errors, []);
const extension = loaded.extensions[0];
const command = extension.commands.get("worktree:switch");
const shortcut = extension.shortcuts.get("ctrl+alt+w");
assert.ok(command && shortcut);
const messages = [];
const dispatches = [];
const notices = [];
loaded.runtime.sendMessage = (message) => messages.push(message.content);
loaded.runtime.sendUserMessage = (...args) => dispatches.push(args);
let switches = 0;
let offered = [];
let select = () => undefined;
const ctx = {
  cwd: main, mode: "tui", isIdle: () => true, waitForIdle: async () => {},
  sessionManager: { getSessionFile: () => sourceSession },
  ui: {
    notify: (text) => notices.push(text),
    select: async (_title, options) => { offered = options; return select(options); },
  },
  async switchSession(file, options) {
    switches++;
    const header = JSON.parse(readFileSync(file, "utf8").split("\n")[0]);
    assert.equal(header.parentSession, sourceSession);
    await options.withSession({ cwd: header.cwd, ui: ctx.ui, sendMessage: () => { throw new Error("手动切换不能续跑"); } });
    ctx.cwd = header.cwd;
    return { cancelled: false };
  },
};
// 尚无 Pi worktrees 根目录时仍能显示主工作区。
await command.handler("", ctx);
assert.equal(offered.length, 1);
assert.match(offered[0], /\[当前\].*主工作区.*main/);
const managed = addWorktree("managed", true);
const detached = addWorktree("detached", true, true);
const foreign = addWorktree("foreign", false);
await command.handler("", ctx);
assert.equal(offered.length, 3);
assert.ok(offered.some((text) => text.includes("managed | feat/managed")));
assert.ok(offered.some((text) => text.includes("detached HEAD")));
assert.ok(offered.every((text) => !text.includes(foreign)));
assert.equal(switches, 0);
select = (options) => options.find((text) => text.includes("[当前]"));
await command.handler("", ctx);
assert.equal(switches, 0);
select = (options) => options.find((text) => text.includes(managed));
await command.handler("", ctx);
assert.equal(switches, 1);
assert.equal(ctx.cwd, managed);
select = () => undefined;
await command.handler("", ctx);
assert.equal(offered.filter((text) => text.includes("[当前]")).length, 1);
assert.ok(offered.find((text) => text.includes("[当前]")).includes(managed));
await command.handler(JSON.stringify({ repoPath: main, worktreePath: main }), ctx);
assert.equal(switches, 2);
assert.equal(ctx.cwd, main);
await command.handler(JSON.stringify({ worktreePath: detached }), ctx);
assert.equal(switches, 3);
await command.handler(JSON.stringify({ worktreePath: foreign }), ctx);
assert.equal(switches, 3);
assert.match(messages.pop(), /所有权标记/);
await extension.commands.get("worktree:migrate").handler(JSON.stringify({ repoPath: main, worktreePath: main }), ctx);
assert.equal(switches, 3);
assert.match(messages.pop(), /主工作区/);
ctx.isIdle = () => false;
await shortcut.handler(ctx);
await command.handler("", ctx);
assert.equal(dispatches.length, 0);
assert.equal(switches, 3);
assert.match(notices.at(-1), /本轮结束后/);
ctx.isIdle = () => true;
await shortcut.handler(ctx);
assert.deepEqual(dispatches, [["/worktree:switch", { expandPromptTemplates: true }]]);
ctx.mode = "rpc";
await command.handler("", ctx);
assert.match(messages.pop(), /选择列表/);
assert.deepEqual(messages, []);
for (const target of [main, managed]) {
  mkdirSync(path.join(target, "src"), { recursive: true });
  ctx.cwd = path.join(target, "src");
  const before = switches;
  await command.handler(JSON.stringify({ worktreePath: target }), ctx);
  assert.equal(switches, before + 1);
  assert.equal(ctx.cwd, target);
  await command.handler(JSON.stringify({ worktreePath: target }), ctx);
  assert.equal(switches, before + 1);
}
assert.deepEqual(messages, []);
console.log(JSON.stringify({ choices: offered, switches, shortcut: dispatches[0], notices }, null, 2));

function addWorktree(name, owned, detached = false) {
  const target = path.join(repo, ".pi", "worktrees", name);
  git(repo, "worktree", "add", ...(detached ? ["--detach"] : ["-b", `feat/${name}`]), target, "main");
  if (owned) {
    const gitDir = git(target, "rev-parse", "--absolute-git-dir").trim();
    writeFileSync(path.join(gitDir, "pi-worktree-manager.json"), JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString() }));
  }
  return realpathSync(target);
}
function git(cwd, ...args) { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }); }
} finally {
  if (!requestedFixture) rmSync(fixture, { recursive: true, force: true });
}
