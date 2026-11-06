import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  OWNERSHIP_MARKER_FILENAME,
  WorktreeError,
  createWorktree,
  isStrictlyWithin,
  listWorktrees,
  parseWorktreePorcelain,
  removeWorktree,
  resolveAgentDir,
  resolveMigrationTarget,
  resolveWorktreeRoot,
  validateCreateInput,
  type CommandRunner,
} from "../src/core.ts";
import { SessionMigrationError, migratePersistentSession } from "../src/session.ts";

const execFileAsync = promisify(execFile);
const EXTENSION_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CREATOR_PATH = path.join(EXTENSION_ROOT, "scripts", "create-worktree.sh");

const realRunner: CommandRunner = {
  async run(command, args, options) {
    try {
      const result = await execFileAsync(command, args, {
        cwd: options?.cwd,
        signal: options?.signal,
        timeout: options?.timeout,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
    } catch (error) {
      const failed = error as Error & { stdout?: string; stderr?: string; code?: number; killed?: boolean };
      return {
        stdout: failed.stdout ?? "",
        stderr: failed.stderr ?? failed.message,
        code: typeof failed.code === "number" ? failed.code : 1,
        killed: failed.killed ?? false,
      };
    }
  },
};

async function withFixture<T>(callback: (fixture: string) => Promise<T>): Promise<T> {
  const fixture = await mkdtemp(path.join(tmpdir(), "worktree-manager-test-"));
  try {
    return await callback(fixture);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

async function createRepository(root: string): Promise<string> {
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.name", "tester");
  await git(repo, "config", "user.email", "tester@example.com");
  await writeFile(path.join(repo, "README.md"), "fixture\n", "utf8");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-qm", "init");
  return repo;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.stdout;
}

function worktreeRootFor(agentDir: string): string {
  return path.join(path.dirname(agentDir), "worktrees");
}

async function ownershipMarkerFile(worktreePath: string): Promise<string> {
  const gitDir = (await git(worktreePath, "rev-parse", "--absolute-git-dir")).trim();
  return path.join(gitDir, OWNERSHIP_MARKER_FILENAME);
}

async function writeOwnershipMarker(worktreePath: string, createdAt: string): Promise<void> {
  await writeFile(
    await ownershipMarkerFile(worktreePath),
    `${JSON.stringify({ schemaVersion: 1, createdAt })}\n`,
    "utf8",
  );
}

async function expectWorktreeError(
  operation: () => Promise<unknown>,
  stage: WorktreeError["stage"],
): Promise<WorktreeError> {
  try {
    await operation();
  } catch (error) {
    assert.ok(error instanceof WorktreeError);
    assert.equal(error.stage, stage);
    return error;
  }
  assert.fail(`预期 WorktreeError(${stage})`);
}

test("validateCreateInput 严格校验三种模式参数组合", () => {
  assert.equal(
    validateCreateInput({ repoPath: "/repo", name: "project-task", mode: "new-branch", baseRef: "main", branch: "feat/a" }).mode,
    "new-branch",
  );
  assert.equal(
    validateCreateInput({ repoPath: "/repo", name: "project-task", mode: "existing-branch", branch: "feat/a" }).mode,
    "existing-branch",
  );
  assert.equal(
    validateCreateInput({ repoPath: "/repo", name: "project-task", mode: "detached", baseRef: "HEAD" }).mode,
    "detached",
  );

  assert.throws(
    () => validateCreateInput({ repoPath: "/repo", name: "Bad_Name", mode: "detached", baseRef: "HEAD" }),
    WorktreeError,
  );
  assert.throws(
    () => validateCreateInput({ repoPath: "/repo", name: "project-task", mode: "new-branch", branch: "feat/a" }),
    /baseRef/,
  );
  assert.throws(
    () => validateCreateInput({ repoPath: "/repo", name: "project-task", mode: "existing-branch", baseRef: "main", branch: "feat/a" }),
    /不能提供 baseRef/,
  );
  assert.throws(
    () => validateCreateInput({ repoPath: "/repo", name: "project-task", mode: "detached", baseRef: "HEAD", branch: "feat/a" }),
    /不能提供 branch/,
  );
});

test("parseWorktreePorcelain 解析 branch、detached、locked 和 prunable", () => {
  const output = [
    "worktree /repo",
    "HEAD 1111111",
    "branch refs/heads/main",
    "",
    "worktree /agent/worktrees/task",
    "HEAD 2222222",
    "detached",
    "locked reason text",
    "prunable stale metadata",
    "",
  ].join("\0");
  assert.deepEqual(parseWorktreePorcelain(output), [
    { path: "/repo", head: "1111111", branch: "main", detached: false, bare: false },
    {
      path: "/agent/worktrees/task",
      head: "2222222",
      detached: true,
      bare: false,
      locked: "reason text",
      prunable: "stale metadata",
    },
  ]);
});

test("isStrictlyWithin 拒绝根目录自身和路径逃逸", () => {
  assert.equal(isStrictlyWithin("/root/worktrees", "/root/worktrees/task"), true);
  assert.equal(isStrictlyWithin("/root/worktrees", "/root/worktrees"), false);
  assert.equal(isStrictlyWithin("/root/worktrees", "/root/other"), false);
});

test("resolveWorktreeRoot 使用 PI_CODING_AGENT_DIR 父级的 worktrees 目录", async () => {
  await withFixture(async (fixture) => {
    const agentDir = path.join(fixture, "pi", "agent");
    const root = await resolveWorktreeRoot({ PI_CODING_AGENT_DIR: `${agentDir}/` }, true);
    assert.equal(root, await realpath(path.join(fixture, "pi", "worktrees")));
  });
});

test("resolveAgentDir 使用默认目录、展开字面 ~ 并拒绝相对路径", () => {
  assert.equal(resolveAgentDir({}), path.join(homedir(), ".pi", "agent"));
  assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "~" }), homedir());
  assert.equal(
    resolveAgentDir({ PI_CODING_AGENT_DIR: "~/pi/agent" }),
    path.join(homedir(), "pi", "agent"),
  );
  assert.throws(
    () => resolveAgentDir({ PI_CODING_AGENT_DIR: "relative/agent" }),
    WorktreeError,
  );
});

test("createWorktree 使用 PI_CODING_AGENT_DIR 并返回 Git 登记结果", async () => {
  await withFixture(async (fixture) => {
    const repo = await createRepository(fixture);
    const agentDir = path.join(fixture, "agent");
    const result = await createWorktree(
      {
        repoPath: repo,
        name: "repo-feature",
        mode: "new-branch",
        baseRef: "main",
        branch: "feat/test",
      },
      { runner: realRunner, creatorPath: CREATOR_PATH, env: { PI_CODING_AGENT_DIR: agentDir } },
    );

    assert.equal(result.repoPath, await realpath(repo));
    assert.equal(
      result.worktreePath,
      await realpath(path.join(worktreeRootFor(agentDir), "repo-feature")),
    );
    assert.equal(result.branch, "feat/test");
    assert.equal(result.setupHook.status, "skipped");

    const listed = await listWorktrees(repo, realRunner, { PI_CODING_AGENT_DIR: agentDir });
    assert.equal(listed.worktrees.length, 1);
    assert.equal(listed.worktrees[0].path, result.worktreePath);
    assert.ok(listed.worktrees[0].createdAt);
    assert.equal(listed.worktrees[0].lastCommitAt, (await git(result.worktreePath, "show", "-s", "--format=%cI", "HEAD")).trim());
    const removed = await removeWorktree(
      { repoPath: repo, worktreePath: result.worktreePath, currentCwd: repo, confirmed: true },
      { runner: realRunner, env: { PI_CODING_AGENT_DIR: agentDir } },
    );
    assert.equal(removed.branchStatus, "deleted");
    assert.equal((await git(repo, "branch", "--list", "feat/test")).trim(), "");
  });
});

test("createWorktree 要求显式批准项目钩子", async () => {
  await withFixture(async (fixture) => {
    const repo = await createRepository(fixture);
    const hook = path.join(repo, ".pi", "worktree", "setup.sh");
    await mkdir(path.dirname(hook), { recursive: true });
    await writeFile(hook, "#!/usr/bin/env bash\nset -euo pipefail\n", { mode: 0o755 });
    await git(repo, "add", ".pi/worktree/setup.sh");
    await git(repo, "commit", "-qm", "hook");

    await expectWorktreeError(
      () =>
        createWorktree(
          { repoPath: repo, name: "repo-hook", mode: "detached", baseRef: "main" },
          {
            runner: realRunner,
            creatorPath: CREATOR_PATH,
            env: { PI_CODING_AGENT_DIR: path.join(fixture, "agent") },
          },
        ),
      "hook-approval",
    );
    assert.equal(
      (await listWorktrees(repo, realRunner, { PI_CODING_AGENT_DIR: path.join(fixture, "agent") }))
        .worktrees.length,
      0,
    );
  });
});

test("createWorktree 拒绝工作树根目录中的符号链接目标占位", async () => {
  await withFixture(async (fixture) => {
    const repo = await createRepository(fixture);
    const agentDir = path.join(fixture, "agent");
    const worktreeRoot = worktreeRootFor(agentDir);
    const outside = path.join(fixture, "outside");
    await mkdir(worktreeRoot, { recursive: true });
    await mkdir(outside);
    await symlink(outside, path.join(worktreeRoot, "repo-link"));

    await expectWorktreeError(
      () =>
        createWorktree(
          { repoPath: repo, name: "repo-link", mode: "detached", baseRef: "main" },
          { runner: realRunner, creatorPath: CREATOR_PATH, env: { PI_CODING_AGENT_DIR: agentDir } },
        ),
      "validation",
    );
  });
});

test("removeWorktree 拒绝未确认、当前 cwd 和脏工作树，默认安全删除分支", async () => {
  await withFixture(async (fixture) => {
    const repo = await createRepository(fixture);
    const agentDir = path.join(fixture, "agent");
    const created = await createWorktree(
      { repoPath: repo, name: "repo-remove", mode: "new-branch", baseRef: "main", branch: "feat/remove" },
      { runner: realRunner, creatorPath: CREATOR_PATH, env: { PI_CODING_AGENT_DIR: agentDir } },
    );

    await expectWorktreeError(
      () =>
        removeWorktree(
          { repoPath: repo, worktreePath: created.worktreePath, currentCwd: repo, confirmed: false },
          { runner: realRunner, env: { PI_CODING_AGENT_DIR: agentDir } },
        ),
      "remove",
    );
    await expectWorktreeError(
      () =>
        removeWorktree(
          {
            repoPath: repo,
            worktreePath: created.worktreePath,
            currentCwd: created.worktreePath,
            confirmed: true,
          },
          { runner: realRunner, env: { PI_CODING_AGENT_DIR: agentDir } },
        ),
      "remove",
    );

    await writeFile(path.join(created.worktreePath, "dirty.txt"), "dirty\n", "utf8");
    await expectWorktreeError(
      () =>
        removeWorktree(
          { repoPath: repo, worktreePath: created.worktreePath, currentCwd: repo, confirmed: true },
          { runner: realRunner, env: { PI_CODING_AGENT_DIR: agentDir } },
        ),
      "remove",
    );
    await rm(path.join(created.worktreePath, "dirty.txt"));

    const removed = await removeWorktree(
      { repoPath: repo, worktreePath: created.worktreePath, currentCwd: repo, confirmed: true },
      { runner: realRunner, env: { PI_CODING_AGENT_DIR: agentDir } },
    );
    assert.equal(removed.branch, "feat/remove");
    assert.equal(removed.branchStatus, "deleted");
    assert.ok(removed.createdAt);
    assert.ok(removed.lastCommitAt);
    assert.equal((await git(repo, "branch", "--list", "feat/remove")).trim(), "");
    assert.equal(
      (await listWorktrees(repo, realRunner, { PI_CODING_AGENT_DIR: agentDir })).worktrees.length,
      0,
    );
  });
});

test("removeWorktree 可仅移除工作树并保留未合并分支", async () => {
  await withFixture(async (fixture) => {
    const repo = await createRepository(fixture);
    const agentDir = path.join(fixture, "agent");
    const env = { PI_CODING_AGENT_DIR: agentDir };
    const created = await createWorktree(
      { repoPath: repo, name: "repo-keep", mode: "new-branch", baseRef: "main", branch: "feat/keep" },
      { runner: realRunner, creatorPath: CREATOR_PATH, env },
    );
    await writeFile(path.join(created.worktreePath, "feature.txt"), "committed\n", "utf8");
    await git(created.worktreePath, "add", "feature.txt");
    await git(created.worktreePath, "commit", "-qm", "feature");
    const listed = await listWorktrees(repo, realRunner, env);
    assert.equal(listed.worktrees[0].lastCommitAt, (await git(created.worktreePath, "show", "-s", "--format=%cI", "HEAD")).trim());

    const removed = await removeWorktree(
      { repoPath: repo, worktreePath: created.worktreePath, currentCwd: repo, confirmed: true, keepBranch: true },
      { runner: realRunner, env },
    );
    assert.equal(removed.branchStatus, "preserved");
    assert.match(await git(repo, "branch", "--list", "feat/keep"), /feat\/keep/);
  });
});

test("removeWorktree 在未合并分支时保留目录和分支", async () => {
  await withFixture(async (fixture) => {
    const repo = await createRepository(fixture);
    const agentDir = path.join(fixture, "agent");
    const env = { PI_CODING_AGENT_DIR: agentDir };
    const created = await createWorktree(
      { repoPath: repo, name: "repo-unmerged", mode: "new-branch", baseRef: "main", branch: "feat/unmerged" },
      { runner: realRunner, creatorPath: CREATOR_PATH, env },
    );
    await writeFile(path.join(created.worktreePath, "feature.txt"), "committed\n", "utf8");
    await git(created.worktreePath, "add", "feature.txt");
    await git(created.worktreePath, "commit", "-qm", "feature");
    const error = await expectWorktreeError(
      () => removeWorktree(
        { repoPath: repo, worktreePath: created.worktreePath, currentCwd: repo, confirmed: true },
        { runner: realRunner, env },
      ),
      "remove",
    );
    assert.match(error.message, /未合并/);
    assert.equal(error.removalStatus, "not-started");
    assert.equal(await realpath(created.worktreePath), created.worktreePath);
    assert.match(await git(repo, "branch", "--list", "feat/unmerged"), /feat\/unmerged/);
  });
});

test("removeWorktree 在已合并主工作区但未合并上游时保留目录", async () => {
  await withFixture(async (fixture) => {
    const repo = await createRepository(fixture);
    const agentDir = path.join(fixture, "agent");
    const env = { PI_CODING_AGENT_DIR: agentDir };
    await git(repo, "branch", "review-base", "main");
    const created = await createWorktree(
      { repoPath: repo, name: "repo-upstream", mode: "new-branch", baseRef: "main", branch: "feat/upstream" },
      { runner: realRunner, creatorPath: CREATOR_PATH, env },
    );
    await git(created.worktreePath, "branch", "--set-upstream-to", "review-base", "feat/upstream");
    await writeFile(path.join(created.worktreePath, "feature.txt"), "committed\n", "utf8");
    await git(created.worktreePath, "add", "feature.txt");
    await git(created.worktreePath, "commit", "-qm", "feature");
    await git(repo, "merge", "--ff-only", "feat/upstream");

    const error = await expectWorktreeError(
      () => removeWorktree(
        { repoPath: repo, worktreePath: created.worktreePath, currentCwd: repo, confirmed: true },
        { runner: realRunner, env },
      ),
      "remove",
    );
    assert.match(error.message, /refs\/heads\/review-base/);
    assert.equal(await realpath(created.worktreePath), created.worktreePath);
    assert.match(await git(repo, "branch", "--list", "feat/upstream"), /feat\/upstream/);
  });
});


test("removeWorktree 删除分支失败时报告部分成功", async () => {
  await withFixture(async (fixture) => {
    const repo = await createRepository(fixture);
    const agentDir = path.join(fixture, "agent");
    const env = { PI_CODING_AGENT_DIR: agentDir };
    const created = await createWorktree(
      { repoPath: repo, name: "repo-partial", mode: "new-branch", baseRef: "main", branch: "feat/partial" },
      { runner: realRunner, creatorPath: CREATOR_PATH, env },
    );
    const failingRunner: CommandRunner = {
      run: (command, args, options) =>
        args.includes("branch") && args.includes("-d")
          ? Promise.resolve({ stdout: "", stderr: "ref locked", code: 1, killed: false })
          : realRunner.run(command, args, options),
    };
    const error = await expectWorktreeError(
      () => removeWorktree(
        { repoPath: repo, worktreePath: created.worktreePath, currentCwd: repo, confirmed: true },
        { runner: failingRunner, env },
      ),
      "branch-remove",
    );
    assert.match(error.message, /工作树已移除.*分支仍保留/);
    assert.equal(error.removalStatus, "removed");
    await assert.rejects(realpath(created.worktreePath));
    assert.match(await git(repo, "branch", "--list", "feat/partial"), /feat\/partial/);
  });
});

test("removeWorktree 忽略上游查询中不属于目标分支的记录", async () => {
  await withFixture(async (fixture) => {
    const repo = await createRepository(fixture);
    const agentDir = path.join(fixture, "agent");
    const env = { PI_CODING_AGENT_DIR: agentDir };
    const created = await createWorktree(
      { repoPath: repo, name: "repo-exact", mode: "new-branch", baseRef: "main", branch: "feat/exact" },
      { runner: realRunner, creatorPath: CREATOR_PATH, env },
    );
    const extraRefRunner: CommandRunner = {
      async run(command, args, options) {
        const result = await realRunner.run(command, args, options);
        return args.includes("for-each-ref")
          ? { ...result, stdout: `refs/heads/feat/exact/child refs/heads/missing\n${result.stdout}` }
          : result;
      },
    };
    const removed = await removeWorktree(
      { repoPath: repo, worktreePath: created.worktreePath, currentCwd: repo, confirmed: true },
      { runner: extraRefRunner, env },
    );
    assert.equal(removed.branchStatus, "deleted");
  });
});

test("removeWorktree 移除后复核失败时声明分支未处理", async () => {
  await withFixture(async (fixture) => {
    const repo = await createRepository(fixture);
    const agentDir = path.join(fixture, "agent");
    const env = { PI_CODING_AGENT_DIR: agentDir };
    const created = await createWorktree(
      { repoPath: repo, name: "repo-verify", mode: "new-branch", baseRef: "main", branch: "feat/verify" },
      { runner: realRunner, creatorPath: CREATOR_PATH, env },
    );
    let listCalls = 0;
    const failingRunner: CommandRunner = {
      run(command, args, options) {
        if (args.includes("worktree") && args.includes("list") && ++listCalls === 2) {
          return Promise.resolve({ stdout: "", stderr: "unavailable", code: 1, killed: false });
        }
        return realRunner.run(command, args, options);
      },
    };
    const error = await expectWorktreeError(
      () => removeWorktree(
        { repoPath: repo, worktreePath: created.worktreePath, currentCwd: repo, confirmed: true },
        { runner: failingRunner, env },
      ),
      "verification",
    );
    assert.match(error.message, /移除命令已成功.*分支未处理/);
    assert.equal(error.removalStatus, "unverified");
    await assert.rejects(realpath(created.worktreePath));
    assert.match(await git(repo, "branch", "--list", "feat/verify"), /feat\/verify/);
  });
});

test("removeWorktree 删除分支命令异常时报告分支状态未确认", async () => {
  await withFixture(async (fixture) => {
    const repo = await createRepository(fixture);
    const agentDir = path.join(fixture, "agent");
    const env = { PI_CODING_AGENT_DIR: agentDir };
    const created = await createWorktree(
      { repoPath: repo, name: "repo-throw", mode: "new-branch", baseRef: "main", branch: "feat/throw" },
      { runner: realRunner, creatorPath: CREATOR_PATH, env },
    );
    const failingRunner: CommandRunner = {
      run: (command, args, options) =>
        args.includes("branch") && args.includes("-d")
          ? Promise.reject(new Error("simulated exec error"))
          : realRunner.run(command, args, options),
    };
    const error = await expectWorktreeError(
      () => removeWorktree(
        { repoPath: repo, worktreePath: created.worktreePath, currentCwd: repo, confirmed: true },
        { runner: failingRunner, env },
      ),
      "branch-remove",
    );
    assert.match(error.message, /工作树已移除.*分支状态未确认/);
    await assert.rejects(realpath(created.worktreePath));
    assert.match(await git(repo, "branch", "--list", "feat/throw"), /feat\/throw/);
  });
});

test("removeWorktree 移除 detached 工作树无需删除分支", async () => {
  await withFixture(async (fixture) => {
    const repo = await createRepository(fixture);
    const agentDir = path.join(fixture, "agent");
    const env = { PI_CODING_AGENT_DIR: agentDir };
    const created = await createWorktree(
      { repoPath: repo, name: "repo-detached", mode: "detached", baseRef: "main" },
      { runner: realRunner, creatorPath: CREATOR_PATH, env },
    );
    const removed = await removeWorktree(
      { repoPath: repo, worktreePath: created.worktreePath, currentCwd: repo, confirmed: true },
      { runner: realRunner, env },
    );
    assert.equal(removed.branchStatus, "not-applicable");
    await assert.rejects(realpath(created.worktreePath));
  });
});


test("removeWorktree 拒绝 Pi 根目录外和未登记路径", async () => {
  await withFixture(async (fixture) => {
    const repo = await createRepository(fixture);
    const agentDir = path.join(fixture, "agent");
    const root = worktreeRootFor(agentDir);
    await mkdir(root, { recursive: true });
    const outside = path.join(fixture, "outside");
    const unregistered = path.join(root, "unregistered");
    await mkdir(outside);
    await mkdir(unregistered);

    await expectWorktreeError(
      () =>
        removeWorktree(
          { repoPath: repo, worktreePath: outside, currentCwd: repo, confirmed: true },
          { runner: realRunner, env: { PI_CODING_AGENT_DIR: agentDir } },
        ),
      "remove",
    );
    await expectWorktreeError(
      () =>
        removeWorktree(
          { repoPath: repo, worktreePath: unregistered, currentCwd: repo, confirmed: true },
          { runner: realRunner, env: { PI_CODING_AGENT_DIR: agentDir } },
        ),
      "remove",
    );
  });
});

test("resolveMigrationTarget 只接受指定仓库登记的 Pi linked worktree", async () => {
  await withFixture(async (fixture) => {
    const repo = await createRepository(fixture);
    const otherRepo = await createRepository(path.join(fixture, "other"));
    const agentDir = path.join(fixture, "agent");
    const created = await createWorktree(
      {
        repoPath: repo,
        name: "migration-target",
        mode: "new-branch",
        baseRef: "main",
        branch: "feat/migration-target",
      },
      { runner: realRunner, creatorPath: CREATOR_PATH, env: { PI_CODING_AGENT_DIR: agentDir } },
    );

    const target = await resolveMigrationTarget(repo, created.worktreePath, {
      runner: realRunner,
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
    assert.equal(await realpath(target.repoPath), await realpath(repo));
    assert.equal(target.worktreePath, await realpath(created.worktreePath));
    assert.equal(target.record.branch, "feat/migration-target");

    await expectWorktreeError(
      () =>
        resolveMigrationTarget(otherRepo, created.worktreePath, {
          runner: realRunner,
          env: { PI_CODING_AGENT_DIR: agentDir },
        }),
      "migration",
    );
    await expectWorktreeError(
      () => resolveMigrationTarget(repo, repo, { runner: realRunner, env: { PI_CODING_AGENT_DIR: agentDir } }),
      "migration",
    );
    const main = await resolveMigrationTarget(created.worktreePath, repo, {
      runner: realRunner, env: { PI_CODING_AGENT_DIR: agentDir }, allowMainWorktree: true,
    });
    assert.equal(main.worktreePath, await realpath(repo));
    assert.equal(main.record.branch, "main");
    await expectWorktreeError(
      () => resolveMigrationTarget(repo, otherRepo, {
        runner: realRunner, env: { PI_CODING_AGENT_DIR: agentDir }, allowMainWorktree: true,
      }),
      "migration",
    );

    const unregistered = path.join(worktreeRootFor(agentDir), "unregistered");
    await mkdir(unregistered, { recursive: true });
    await expectWorktreeError(
      () =>
        resolveMigrationTarget(repo, unregistered, {
          runner: realRunner,
          env: { PI_CODING_AGENT_DIR: agentDir },
        }),
      "migration",
    );
  });
});

test("createWorktree after-create 失败时保留带所有权标记的 Pi 工作树", async () => {
  await withFixture(async (fixture) => {
    const repo = await createRepository(fixture);
    const hook = path.join(repo, ".pi", "worktree", "setup.sh");
    await mkdir(path.dirname(hook), { recursive: true });
    await writeFile(
      hook,
      '#!/usr/bin/env bash\nset -euo pipefail\nif [[ "$1" == "after-create" ]]; then exit 23; fi\n',
      { mode: 0o755 },
    );
    await git(repo, "add", ".pi/worktree/setup.sh");
    await git(repo, "commit", "-qm", "hook");
    const agentDir = path.join(fixture, "agent");
    const env = { PI_CODING_AGENT_DIR: agentDir };

    const error = await expectWorktreeError(
      () =>
        createWorktree(
          {
            repoPath: repo,
            name: "repo-after-fail",
            mode: "new-branch",
            baseRef: "main",
            branch: "feat/after-fail",
            setupHookApproved: true,
          },
          { runner: realRunner, creatorPath: CREATOR_PATH, env },
        ),
      "after-create",
    );
    assert.match(error.message, /已保留工作树/);

    const target = await realpath(path.join(worktreeRootFor(agentDir), "repo-after-fail"));
    const marker = await readFile(await ownershipMarkerFile(target), "utf8");
    assert.match(marker, /"schemaVersion":1/);
    assert.match(marker, /"createdAt":"\d{4}-\d{2}-\d{2}T/);

    const listed = await listWorktrees(repo, realRunner, env);
    assert.deepEqual(
      listed.worktrees.map((record) => record.path),
      [target],
    );
    assert.ok(listed.worktrees[0].createdAt);
  });
});

test("listWorktrees 只返回带有效所有权标记的 Pi 工作树", async () => {
  await withFixture(async (fixture) => {
    const repo = await createRepository(fixture);
    const agentDir = path.join(fixture, "agent");
    const env = { PI_CODING_AGENT_DIR: agentDir };
    const root = worktreeRootFor(agentDir);
    await mkdir(root, { recursive: true });

    const foreign = path.join(root, "foreign-worktree");
    await git(repo, "worktree", "add", "-b", "feat/foreign", foreign, "main");

    const owned = await createWorktree(
      { repoPath: repo, name: "owned-worktree", mode: "new-branch", baseRef: "main", branch: "feat/owned" },
      { runner: realRunner, creatorPath: CREATOR_PATH, env },
    );
    const broken = await createWorktree(
      { repoPath: repo, name: "broken-worktree", mode: "new-branch", baseRef: "main", branch: "feat/broken" },
      { runner: realRunner, creatorPath: CREATOR_PATH, env },
    );
    await writeFile(await ownershipMarkerFile(broken.worktreePath), "{not-json", "utf8");

    const listed = await listWorktrees(repo, realRunner, env);
    assert.deepEqual(
      listed.worktrees.map((record) => record.path),
      [await realpath(owned.worktreePath)],
    );

    await expectWorktreeError(
      () =>
        removeWorktree(
          { repoPath: repo, worktreePath: foreign, currentCwd: repo, confirmed: true },
          { runner: realRunner, env },
        ),
      "remove",
    );
    await expectWorktreeError(
      () => resolveMigrationTarget(repo, foreign, { runner: realRunner, env }),
      "migration",
    );
    await expectWorktreeError(
      () =>
        removeWorktree(
          { repoPath: repo, worktreePath: broken.worktreePath, currentCwd: repo, confirmed: true },
          { runner: realRunner, env },
        ),
      "remove",
    );
  });
});

test("listWorktrees 按 createdAt 倒序并用路径稳定排序", async () => {
  await withFixture(async (fixture) => {
    const repo = await createRepository(fixture);
    const agentDir = path.join(fixture, "agent");
    const env = { PI_CODING_AGENT_DIR: agentDir };

    const alpha = await createWorktree(
      { repoPath: repo, name: "list-alpha", mode: "new-branch", baseRef: "main", branch: "feat/list-alpha" },
      { runner: realRunner, creatorPath: CREATOR_PATH, env },
    );
    const beta = await createWorktree(
      { repoPath: repo, name: "list-beta", mode: "new-branch", baseRef: "main", branch: "feat/list-beta" },
      { runner: realRunner, creatorPath: CREATOR_PATH, env },
    );
    const alphaPath = await realpath(alpha.worktreePath);
    const betaPath = await realpath(beta.worktreePath);

    await writeOwnershipMarker(alpha.worktreePath, "2026-01-02T00:00:00.000Z");
    await writeOwnershipMarker(beta.worktreePath, "2026-01-01T00:00:00.000Z");
    let listed = await listWorktrees(repo, realRunner, env);
    assert.deepEqual(
      listed.worktrees.map((record) => record.path),
      [alphaPath, betaPath],
    );
    assert.deepEqual(
      listed.worktrees.map((record) => record.createdAt),
      ["2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    );

    await writeOwnershipMarker(alpha.worktreePath, "2026-01-01T00:00:00.000Z");
    listed = await listWorktrees(repo, realRunner, env);
    assert.deepEqual(
      listed.worktrees.map((record) => record.path),
      [alphaPath, betaPath],
    );
  });
});

test("listWorktrees 在根目录解析遇到非 ENOENT 错误时明确报错", async () => {
  await withFixture(async (fixture) => {
    const repo = await createRepository(fixture);
    const blocker = path.join(fixture, "blocker");
    await writeFile(blocker, "not a directory\n", "utf8");
    const env = { PI_CODING_AGENT_DIR: path.join(blocker, "pi", "agent") };

    const error = await expectWorktreeError(() => listWorktrees(repo, realRunner, env), "list");
    assert.match(error.message, /无法解析 Pi 工作树根目录/);
    assert.equal(error.worktreePath, path.join(blocker, "pi", "worktrees"));
  });
});

test("根目录不存在时按调用场景归类错误阶段", async () => {
  await withFixture(async (fixture) => {
    const repo = await createRepository(fixture);
    const agentDir = path.join(fixture, "pi", "agent");
    const env = { PI_CODING_AGENT_DIR: agentDir };
    const missing = path.join(fixture, "pi", "worktrees", "missing");

    await expectWorktreeError(
      () => resolveMigrationTarget(repo, missing, { runner: realRunner, env }),
      "migration",
    );
    await expectWorktreeError(
      () =>
        removeWorktree(
          { repoPath: repo, worktreePath: missing, currentCwd: repo, confirmed: true },
          { runner: realRunner, env },
        ),
      "remove",
    );
    await expectWorktreeError(() => resolveWorktreeRoot(env, false), "remove");
  });
});

test("migratePersistentSession 按 fork、switch、replacement 验证顺序迁移", async () => {
  await withFixture(async (fixture) => {
    const target = path.join(fixture, "target");
    await mkdir(target);
    const calls: string[] = [];
    const notices: string[] = [];
    const ctx = {
      cwd: fixture,
      sessionManager: { getSessionFile: () => "/sessions/source.jsonl" },
      switchSession: async (sessionPath: string, options?: { withSession?: (ctx: never) => Promise<void> }) => {
        calls.push(`switch:${sessionPath}`);
        await options?.withSession?.({ cwd: target, ui: { notify: (message: string) => notices.push(message) } } as never);
        calls.push("replacement");
        return { cancelled: false };
      },
    };
    const result = await migratePersistentSession(
      ctx as never,
      target,
      {
        forkFrom(sourcePath, targetCwd) {
          calls.push(`fork:${sourcePath}:${targetCwd}`);
          return { getSessionFile: () => "/sessions/migrated.jsonl" };
        },
      },
      "迁移完成",
    );

    assert.equal(result.status, "migrated");
    assert.deepEqual(calls, [
      `fork:/sessions/source.jsonl:${await realpath(target)}`,
      "switch:/sessions/migrated.jsonl",
      "replacement",
    ]);
    assert.deepEqual(notices, ["迁移完成"]);
  });
});

test("migratePersistentSession 对临时会话降级且不 fork/switch", async () => {
  await withFixture(async (fixture) => {
    let called = false;
    const result = await migratePersistentSession(
      {
        cwd: fixture,
        sessionManager: { getSessionFile: () => undefined },
        switchSession: async () => {
          called = true;
          return { cancelled: false };
        },
      } as never,
      fixture,
      {
        forkFrom() {
          called = true;
          return { getSessionFile: () => undefined };
        },
      },
    );
    assert.equal(result.status, "unavailable");
    assert.equal(called, false);
  });
});

test("migratePersistentSession 区分切换取消并保留迁移会话路径", async () => {
  await withFixture(async (fixture) => {
    await assert.rejects(
      () =>
        migratePersistentSession(
          {
            cwd: fixture,
            sessionManager: { getSessionFile: () => "/sessions/source.jsonl" },
            switchSession: async () => ({ cancelled: true }),
          } as never,
          fixture,
          { forkFrom: () => ({ getSessionFile: () => "/sessions/migrated.jsonl" }) },
        ),
      (error: unknown) => {
        assert.ok(error instanceof SessionMigrationError);
        assert.equal(error.migratedSessionFile, "/sessions/migrated.jsonl");
        return true;
      },
    );
  });
});
