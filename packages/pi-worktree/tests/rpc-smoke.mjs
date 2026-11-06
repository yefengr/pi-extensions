import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

const scenario = process.argv[2];
const fixture = process.env.FIXTURE;
const extension = process.env.EXTENSION;
if (!scenario || !fixture || !extension) {
  throw new Error("用法：FIXTURE=<目录> EXTENSION=<index.ts> node rpc-smoke.mjs <persistent|ephemeral|after-failure>");
}

const repo = path.join(fixture, "repo");
const agentDir = path.join(fixture, "agent");
const sessionDir = path.join(fixture, "sessions");
const sourceSession = path.join(fixture, "source.jsonl");
mkdirSync(repo, { recursive: true });
mkdirSync(agentDir, { recursive: true });
mkdirSync(sessionDir, { recursive: true });
runGit(repo, "init", "-q", "-b", "main");
runGit(repo, "config", "user.name", "tester");
runGit(repo, "config", "user.email", "tester@example.com");
writeFileSync(path.join(repo, "README.md"), "fixture\n");
runGit(repo, "add", "README.md");
runGit(repo, "commit", "-qm", "init");

if (scenario === "after-failure") {
  const hook = path.join(repo, ".pi", "worktree", "setup.sh");
  mkdirSync(path.dirname(hook), { recursive: true });
  writeFileSync(
    hook,
    "#!/usr/bin/env bash\nset -euo pipefail\nif [[ \"$1\" == \"after-create\" ]]; then exit 29; fi\n",
    { mode: 0o755 },
  );
  runGit(repo, "add", ".pi/worktree/setup.sh");
  runGit(repo, "commit", "-qm", "hook");
}

const repoReal = realpathSync(repo);
if (scenario !== "ephemeral") {
  writeFileSync(
    sourceSession,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "11111111-1111-7111-8111-111111111111",
      timestamp: "2026-08-12T00:00:00.000Z",
      cwd: repoReal,
    })}\n`,
  );
}

const targetName = `rpc-${scenario}`;
const branch = `feat/rpc-${scenario}`;
// create 类场景：验证工作树创建与分支；list/migrate 场景不创建
const createScenarios = new Set(["persistent", "ephemeral", "after-failure", "default-repo-path"]);
// default-repo-path 场景验证：不传 repoPath，命令缺省回落到会话 cwd
const removeScenarios = new Set(["remove-default", "remove-keep"]);
let removeTarget;
if (removeScenarios.has(scenario)) {
  const root = path.join(path.dirname(agentDir), "worktrees");
  mkdirSync(root, { recursive: true });
  removeTarget = path.join(root, targetName);
  runGit(repo, "worktree", "add", "-b", branch, removeTarget, "main");
  const gitDir = runGit(removeTarget, "rev-parse", "--absolute-git-dir").trim();
  writeFileSync(
    path.join(gitDir, "pi-worktree-manager.json"),
    `${JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString() })}\n`,
  );
}
const commandInput = scenario === "default-repo-path"
  ? {
      name: targetName,
      mode: "new-branch",
      baseRef: "main",
      branch,
    }
  : {
      repoPath: repoReal,
      name: targetName,
      mode: "new-branch",
      baseRef: "main",
      branch,
      ...(scenario === "after-failure" ? { setupHookApproved: true } : {}),
    };
const piArgs = [
  "--mode",
  "rpc",
  "--offline",
  ...(scenario === "ephemeral" ? ["--no-session"] : ["--session", sourceSession, "--session-dir", sessionDir]),
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "-e",
  extension,
];

const promptMessage = removeScenarios.has(scenario)
  ? `/worktree:remove ${JSON.stringify({
      repoPath: repoReal,
      worktreePath: realpathSync(removeTarget),
      confirmed: true,
      ...(scenario === "remove-keep" ? { keepBranch: true } : {}),
    })}`
  : scenario === "default-repo-list"
    ? "/worktree:list"
    : scenario === "migrate-no-worktree-path"
      ? "/worktree:migrate {}"
      : `/worktree:create ${JSON.stringify(commandInput)}`;
const expectError = scenario === "after-failure" || scenario === "migrate-no-worktree-path";
const { records, finalState } = await driveRpc(piArgs, promptMessage, expectError);

let target;
let targetBranch;
if (createScenarios.has(scenario)) {
  target = realpathSync(path.join(path.dirname(agentDir), "worktrees", targetName));
  targetBranch = runGit(target, "branch", "--show-current").trim();
  if (targetBranch !== branch) throw new Error(`目标分支不匹配：${targetBranch}`);
}

if (scenario === "persistent" || scenario === "default-repo-path") {
  const migratedSessionFile = finalState.data.sessionFile;
  if (!migratedSessionFile || migratedSessionFile === sourceSession) throw new Error("持久会话未迁移");
  const header = JSON.parse(readFileSync(migratedSessionFile, "utf8").split("\n")[0]);
  if (realpathSync(header.cwd) !== target) throw new Error(`迁移 header cwd 不匹配：${header.cwd}`);
  if (header.parentSession !== sourceSession) throw new Error("parentSession 不匹配");
  const notice = findText(records, "Pi 会话已迁移到");
  if (!notice?.includes(target)) throw new Error("缺少迁移完成通知");
  console.log(JSON.stringify({ scenario, sourceCwd: repoReal, targetCwd: target, migratedSessionFile, notice }, null, 2));
} else if (scenario === "ephemeral") {
  if (finalState.data.sessionFile !== undefined) throw new Error("临时会话不应产生 sessionFile");
  const notice = findText(records, "当前会话未持久化，无法自动迁移");
  if (!notice) throw new Error(`缺少临时会话降级提示：${records.map(JSON.stringify).join("\n")}`);
  console.log(JSON.stringify({ scenario, sourceCwd: repoReal, targetCwd: target, sessionFile: null, notice }, null, 2));
} else if (scenario === "after-failure") {
  if (finalState.data.sessionFile !== sourceSession) throw new Error("after-create 失败后会话不应切换");
  const errorText = findText(records, "after-create 阶段失败");
  if (!errorText) throw new Error(`缺少 after-create 失败提示：${records.map(JSON.stringify).join("\n")}`);
  console.log(JSON.stringify({ scenario, sourceCwd: repoReal, retainedWorktree: target, sessionFile: finalState.data.sessionFile, errorText }, null, 2));
} else if (removeScenarios.has(scenario)) {
  const notice = findText(records, "工作树已移除：");
  if (!notice?.includes("创建：") || !notice.includes("最近提交：")) {
    throw new Error(`移除命令未显示工作树及时间：${records.map(JSON.stringify).join("\n")}`);
  }
  if (scenario === "remove-keep" && !notice.includes("关联分支：已保留")) {
    throw new Error("保留分支选项未生效");
  }
  if (scenario === "remove-default" && !notice.includes("关联分支：已删除")) {
    throw new Error("默认没有删除分支");
  }
  if (runGit(repo, "branch", "--list", branch).includes(branch) !== (scenario === "remove-keep")) {
    throw new Error("命令输出与分支实际状态不一致");
  }
  console.log(JSON.stringify({ scenario, notice }, null, 2));
} else if (scenario === "default-repo-list") {
  if (finalState.data.sessionFile !== sourceSession) throw new Error("list 不应迁移会话");
  const listText = findText(records, "仓库：");
  if (!listText?.includes(repoReal)) throw new Error(`缺少缺省回落的仓库列表：${records.map(JSON.stringify).join("\n")}`);
  console.log(JSON.stringify({ scenario, listText }, null, 2));
} else if (scenario === "migrate-no-worktree-path") {
  if (finalState.data.sessionFile !== sourceSession) throw new Error("migrate 缺参失败不应迁移会话");
  const errorText = findText(records, "当前模式不能交互收集参数");
  if (!errorText) throw new Error(`缺少非 TUI 交互收集报错：${records.map(JSON.stringify).join("\n")}`);
  console.log(JSON.stringify({ scenario, errorText }, null, 2));
} else {
  throw new Error(`未知场景：${scenario}`);
}

function runGit(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function findText(records, needle) {
  for (const record of records) {
    const candidates = [record.message?.content, record.message, record.content, record.message?.message];
    for (const value of candidates) {
      if (typeof value === "string" && value.includes(needle)) return value;
    }
  }
  return undefined;
}

async function driveRpc(args, message, expectError) {
  const child = spawn(process.execPath, [process.env.PI_CLI, ...args], {
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const records = [];
  let buffer = "";
  let stderr = "";
  let stateRequested = false;
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const finalStatePromise = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const record = JSON.parse(line);
        records.push(record);
        if (record.id === "create" && record.type === "response" && !stateRequested) {
          if (!record.success) {
            reject(new Error(`create RPC 失败：${line}`));
            return;
          }
          stateRequested = true;
          child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
        }
        if (record.id === "state" && record.type === "response") resolve(record);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (!stateRequested) reject(new Error(`Pi 提前退出 ${code}：${stderr}`));
    });
  });

  child.stdin.write(`${JSON.stringify({ id: "create", type: "prompt", message })}\n`);
  const timeout = setTimeout(() => child.kill("SIGTERM"), 60_000);
  const finalState = await finalStatePromise;
  clearTimeout(timeout);
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("close", resolve));
  const errorMessage = findText(records, "错误：");
  if (expectError && !errorMessage) throw new Error("预期扩展错误消息但未收到");
  if (!expectError && errorMessage) throw new Error(`收到意外错误：${errorMessage}`);
  return { records, finalState };
}
