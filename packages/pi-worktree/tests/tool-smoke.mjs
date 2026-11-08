import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const fixture = process.env.FIXTURE;
const extensionPath = process.env.EXTENSION;
const piPackage = process.env.PI_PACKAGE;
if (!fixture || !extensionPath || !piPackage) {
  throw new Error("缺少 FIXTURE、EXTENSION 或 PI_PACKAGE");
}

const { discoverAndLoadExtensions } = await import(pathToFileURL(piPackage).href);
const repo = path.join(fixture, "repo");
const agentDir = path.join(fixture, "agent");
mkdirSync(repo, { recursive: true });
mkdirSync(agentDir, { recursive: true });
runGit(repo, "init", "-q", "-b", "main");
runGit(repo, "config", "user.name", "tester");
runGit(repo, "config", "user.email", "tester@example.com");
writeFileSync(path.join(repo, "README.md"), "fixture\n");
runGit(repo, "add", "README.md");
runGit(repo, "commit", "-qm", "init");

process.env.PI_CODING_AGENT_DIR = agentDir;
const loaded = await discoverAndLoadExtensions(
  [extensionPath],
  realpathSync.native(repo),
  path.join(fixture, "empty-agent-dir"),
);
if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
const extension = loaded.extensions[0];
const tool = (name) => {
  const registered = extension.tools.get(name);
  if (!registered) throw new Error(`工具未注册：${name}`);
  return registered.definition;
};
let uiStatusCalls = 0;
const context = {
  cwd: realpathSync.native(repo),
  mode: "json", hasUI: false,
  ui: { setStatus() { uiStatusCalls++; } },
  sessionManager: { getSessionFile: () => undefined },
};
const updates = [];
const defaultRepoPath = process.env.DEFAULT_REPO_PATH === "1";

const createdResult = await tool("worktree_create").execute(
  "create-1",
  {
    ...(defaultRepoPath ? {} : { repoPath: realpathSync.native(repo) }),
    name: "tool-smoke",
    mode: "new-branch",
    baseRef: "main",
    branch: "feat/tool-smoke",
  },
  undefined,
  (update) => updates.push(update),
  context,
);
const created = createdResult.details;
if (created.migrationStatus !== "unavailable") throw new Error("临时会话工具创建未返回不可迁移状态");
if (createdResult.terminate) throw new Error("临时会话不应安排自动迁移或终止本轮");
if (!created.migrationReason?.includes("未持久化")) throw new Error("缺少临时会话降级原因");
if (typeof created.migrationCommand !== "string" || !created.migrationCommand.startsWith("/worktree:migrate ")) {
  throw new Error("工具创建未返回失败恢复命令");
}
if (created.branch !== "feat/tool-smoke") throw new Error("工具创建分支不匹配");
const target = realpathSync.native(path.join(path.dirname(agentDir), "worktrees", "tool-smoke"));
if (created.worktreePath !== target) throw new Error("工具创建路径不匹配");
if (updates.length === 0) throw new Error("工具创建未发送进度更新");

const listedResult = await tool("worktree_list").execute(
  "list-1",
  defaultRepoPath ? {} : { repoPath: repo },
  undefined,
  undefined,
  context,
);
if (listedResult.details.worktrees.length !== 1) {
  throw new Error("工具列表结果数量不匹配（应只包含 Pi 管理的工作树）");
}
if (!listedResult.details.worktrees[0].createdAt || !listedResult.details.worktrees[0].lastCommitAt) {
  throw new Error("工具列表未返回创建及最近提交时间");
}
if (!listedResult.content[0].text.includes("创建：") || !listedResult.content[0].text.includes("最近提交：")) {
  throw new Error("工具列表未显示时间");
}

const removeUpdates = [];
const removedResult = await tool("worktree_remove").execute(
  "remove-1",
  { ...(defaultRepoPath ? {} : { repoPath: repo }), worktreePath: target, confirmed: true },
  new AbortController().signal,
  (update) => removeUpdates.push(update),
  context,
);
assert.ok(removeUpdates.length >= 4);
for (const phase of ["检查", "移除", "复核", "删除关联分支"]) {
  assert.ok(removeUpdates.some((update) => update.content[0].text.includes(`正在${phase} tool-smoke`)), phase);
}
for (const update of [...updates, ...removeUpdates]) {
  assert.equal(update.details, undefined);
  assert.match(update.content[0].text, /已耗时 \d+ 秒/);
}
if (removedResult.details.branchStatus !== "deleted") throw new Error("工具默认未删除分支");
if (runGit(repo, "branch", "--list", "feat/tool-smoke").trim()) {
  throw new Error("工具移除后分支仍存在");
}
if (!removedResult.content[0].text.includes("最近提交：") || !removedResult.content[0].text.includes("关联分支：已删除")) {
  throw new Error("工具移除结果未显示时间或分支状态");
}

const keptResult = await tool("worktree_create").execute(
  "create-keep",
  { repoPath: repo, name: "tool-keep", mode: "new-branch", baseRef: "main", branch: "feat/tool-keep" },
  undefined,
  undefined,
  context,
);
const keptTarget = keptResult.details.worktreePath;
const aborted = new AbortController();
aborted.abort();
let abortedUpdates = 0;
await assert.rejects(tool("worktree_remove").execute(
  "remove-aborted", { repoPath: repo, worktreePath: keptTarget, confirmed: true },
  aborted.signal, () => { abortedUpdates++; }, context,
));
assert.equal(abortedUpdates, 0);
assert.ok(runGit(repo, "worktree", "list", "--porcelain").includes(keptTarget.replaceAll("\\", "/")));
writeFileSync(path.join(keptTarget, "feature.txt"), "committed\n");
runGit(keptTarget, "add", "feature.txt");
runGit(keptTarget, "commit", "-qm", "feature");
const keepResult = await tool("worktree_remove").execute(
  "remove-keep",
  { repoPath: repo, worktreePath: keptTarget, confirmed: true, keepBranch: true },
  undefined,
  undefined,
  context,
);
if (keepResult.details.branchStatus !== "preserved") throw new Error("工具保留分支选项无效");
if (!runGit(repo, "branch", "--list", "feat/tool-keep").includes("feat/tool-keep")) {
  throw new Error("工具 keepBranch=true 后分支不存在");
}

assert.equal(uiStatusCalls, 0, "无 UI 工具不应访问终端状态");
console.log(JSON.stringify({
  tools: [...extension.tools.keys()],
  defaultRepoPath,
  created: {
    worktreePath: created.worktreePath,
    branch: created.branch,
    migrationStatus: created.migrationStatus,
    migrationCommand: created.migrationCommand,
  },
  listedCount: listedResult.details.worktrees.length,
  removed: removedResult.details,
  kept: keepResult.details,
}, null, 2));

function runGit(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
