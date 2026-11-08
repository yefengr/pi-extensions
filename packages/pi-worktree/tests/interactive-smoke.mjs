import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const extensionPath = process.env.EXTENSION;
const piPackage = process.env.PI_PACKAGE;
if (!extensionPath || !piPackage) throw new Error("缺少 EXTENSION 或 PI_PACKAGE");
const { discoverAndLoadExtensions } = await import(pathToFileURL(piPackage).href);

for (const scenario of [
  "batch-refresh", "batch-keep", "preflight-reject", "cancel-confirm", "branch-changed", "branch-delete-fail", "partial-stop",
]) {
  const fixture = mkdtempSync(path.join(tmpdir(), "worktree-interactive-"));
  try {
    await runScenario(fixture, scenario);
    console.log(`ok - ${scenario}`);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

async function runScenario(fixture, scenario) {
  const repo = path.join(fixture, "repo");
  const agentDir = path.join(fixture, "agent");
  mkdirSync(repo);
  mkdirSync(agentDir);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "tester");
  git(repo, "config", "user.email", "tester@example.com");
  writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "init");
  const paths = ["first", "second", "third"].map((name, index) => {
    const target = path.join(fixture, "worktrees", name);
    git(repo, "worktree", "add", "-b", `feat/${name}`, target, "main");
    const gitDir = git(target, "rev-parse", "--absolute-git-dir").trim();
    writeFileSync(path.join(gitDir, "pi-worktree-manager.json"), JSON.stringify({
      schemaVersion: 1,
      createdAt: new Date(Date.now() - index * 60_000).toISOString(),
    }));
    return realpathSync.native(target);
  });
  if (scenario === "preflight-reject") {
    writeFileSync(path.join(paths[1], "feature.txt"), "committed\n");
    git(paths[1], "add", "feature.txt");
    git(paths[1], "commit", "-qm", "feature");
  }

  process.env.PI_CODING_AGENT_DIR = agentDir;
  const loaded = await discoverAndLoadExtensions([extensionPath], realpathSync.native(repo), path.join(fixture, "empty-agent"));
  if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
  const messages = [];
  loaded.runtime.sendMessage = (message) => messages.push(message.content);
  const command = loaded.extensions[0].commands.get("worktree:remove");
  if (!command) throw new Error("未注册 /worktree:remove");
  let selections = 0;
  let confirmations = 0;
  const statuses = new Map();
  const progress = [];
  const context = {
    cwd: realpathSync.native(repo),
    mode: "tui",
    hasUI: true,
    ui: {
      setStatus(key, text) {
        if (text === undefined) statuses.delete(key);
        else { statuses.set(key, text); progress.push(text); }
      },
      async custom(factory) {
        assert.equal(statuses.size, 0, "选择器打开前应清理加载状态");
        selections++;
        return new Promise((resolve) => {
          const theme = { fg: (_color, text) => text };
          const keys = { matches: (data, binding) => binding === "tui.select.confirm" && data === "\r" };
          const component = factory({ requestRender() {} }, theme, keys, resolve);
          if (selections === 2) {
            const expectedCount = ["batch-refresh", "batch-keep"].includes(scenario) ? 1 : 3;
            assert.notEqual(scenario, "partial-stop");
            assert.ok(component.render(80).join("\n").includes(`(0/${expectedCount})`));
            component.handleInput("\x1b");
            return;
          }
          assert.match(component.render(80).join("\n"), /选择要移除的工作树 \(0\/3\)/);
          component.render(24);
          component.handleInput(" ");
          component.handleInput("\x1b[B");
          component.handleInput(" ");
          assert.equal(component.render(80).filter((line) => line.includes("[x]")).length, 2);
          component.handleInput("\r");
        });
      },
      async select(_title, options) {
        assert.equal(statuses.size, 0, "范围选择期间不应显示执行状态");
        return options[scenario === "batch-keep" ? 1 : 0];
      },
      async confirm(_title, body) {
        assert.equal(statuses.size, 0, "确认期间不应显示执行状态");
        assert.ok(progress.some((text) => /正在检查 1\/2：first/.test(text)));
        assert.ok(progress.some((text) => /正在检查 2\/2：second/.test(text)));
        confirmations++;
        assert.match(body, /first/);
        assert.match(body, /second/);
        assert.match(body, /GMT[+-]?\d*/);
        if (scenario === "partial-stop") writeFileSync(path.join(paths[1], "dirty.txt"), "dirty\n");
        if (scenario === "branch-changed") git(paths[0], "switch", "-q", "-c", "feat/switched");
        if (scenario === "branch-delete-fail") {
          writeFileSync(path.join(repo, ".git", "refs", "heads", "feat", "first.lock"), "locked\n");
        }
        return scenario !== "cancel-confirm";
      },
    },
  };
  await command.handler("", context);
  assert.equal(statuses.size, 0, "成功、失败或取消后状态均应清理");
  assert.ok(progress.some((text) => /正在加载工作树.*已耗时 \d+ 秒/.test(text)));
  if (["batch-refresh", "batch-keep", "partial-stop", "branch-delete-fail"].includes(scenario)) {
    for (const phase of ["移除", "复核", ...(scenario === "batch-keep" ? [] : ["删除关联分支"])]) {
      assert.ok(progress.some((text) => text.includes(`正在${phase} 1/2：first`)), phase);
    }
  }
  if (scenario === "batch-refresh" || scenario === "batch-keep") {
    assert.ok(progress.some((text) => text.includes("正在移除 2/2：second")));
    assert.ok(progress.filter((text) => text.includes("正在加载工作树")).length >= 2);
  }
  if (scenario === "cancel-confirm" || scenario === "preflight-reject" || scenario === "branch-changed") {
    assert.ok(progress.every((text) => !text.includes("正在移除")));
  }

  if (scenario === "batch-refresh" || scenario === "batch-keep") {
    assert.equal(selections, 2);
    assert.equal(confirmations, 1);
    assert.equal(existsSync(paths[0]), false);
    assert.equal(existsSync(paths[1]), false);
    assert.equal(existsSync(paths[2]), true);
    assert.ok(messages.some((text) => text.includes("本轮已确认移除 2/2 个工作树")));
    const firstBranch = git(repo, "branch", "--list", "feat/first").trim();
    assert.equal(Boolean(firstBranch), scenario === "batch-keep");
  } else if (scenario === "preflight-reject") {
    assert.equal(selections, 2);
    assert.equal(confirmations, 0);
    assert.ok(paths.every(existsSync));
    assert.ok(messages.some((text) => text.includes("未合并")));
  } else if (scenario === "cancel-confirm") {
    assert.equal(selections, 2);
    assert.equal(confirmations, 1);
    assert.ok(paths.every(existsSync));
    assert.equal(messages.length, 0);
  } else if (scenario === "branch-changed") {
    assert.equal(selections, 1);
    assert.ok(paths.every(existsSync));
    assert.ok(messages.some((text) => text.includes("本轮已确认移除 0/2 个工作树")));
    assert.ok(messages.some((text) => text.includes("确认后发生变化")));
    assert.ok(git(repo, "branch", "--list", "feat/first").includes("feat/first"));
  } else if (scenario === "branch-delete-fail") {
    assert.equal(selections, 1);
    assert.equal(existsSync(paths[0]), false);
    assert.equal(existsSync(paths[1]), true);
    assert.equal(existsSync(paths[2]), true);
    assert.ok(messages.some((text) => text.includes("本轮已确认移除 1/2 个工作树")));
    assert.ok(messages.some((text) => text.includes("分支仍保留")));
    assert.ok(git(repo, "branch", "--list", "feat/first").includes("feat/first"));
  } else {
    assert.equal(selections, 1);
    assert.equal(confirmations, 1);
    assert.equal(existsSync(paths[0]), false);
    assert.equal(existsSync(paths[1]), true);
    assert.equal(existsSync(paths[2]), true);
    assert.ok(messages.some((text) => text.includes("本轮已确认移除 1/2 个工作树")));
    assert.ok(messages.some((text) => text.includes("批量操作已停止")));
  }
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
