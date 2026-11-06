import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WorktreeError, type CommandRunner } from "../src/core.ts";
import { inspectRemoveWorktree, removeWorktree, type RemoveWorktreePhase } from "../src/worktree-remove.ts";

test("删除 observer 报告真实阶段，拒绝和部分失败不宣称完成", async (t) => {
  for (const scenario of ["success", "keep", "dirty", "unconfirmed", "changed", "verify-failure", "branch-failure", "sink-failure"]) {
    await t.test(scenario, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "remove-progress-"));
      try {
        const repo = path.join(root, "repo");
        const target = path.join(root, "worktrees", "target");
        await mkdir(repo);
        const git = (...args: string[]) => {
          const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
          assert.equal(result.status, 0, result.stderr);
          return result.stdout.trim();
        };
        git("init", "-q", "-b", "main");
        git("config", "user.name", "tester");
        git("config", "user.email", "tester@example.com");
        await writeFile(path.join(repo, "README.md"), "fixture\n");
        git("add", "README.md");
        git("commit", "-qm", "init");
        git("worktree", "add", "-q", "-b", "feat/target", target, "main");
        const gitDir = git("-C", target, "rev-parse", "--absolute-git-dir");
        await writeFile(path.join(gitDir, "pi-worktree-manager.json"), JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString() }));
        const canonicalTarget = await realpath(target);
        let removed = false;
        const runner: CommandRunner = { async run(command, args) {
          if ((scenario === "verify-failure" && removed && args.includes("--porcelain")) ||
            (scenario === "branch-failure" && args.includes("-d"))) {
            return { code: 1, stdout: "", stderr: "synthetic command failure", killed: false };
          }
          const result = spawnSync(command, args, { encoding: "utf8" });
          if (result.error) throw result.error;
          if (args.includes("remove") && result.status === 0) removed = true;
          return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, killed: false };
        } };
        const options = { runner, env: { PI_CODING_AGENT_DIR: path.join(root, "agent") } };
        const input = { repoPath: repo, worktreePath: target, currentCwd: repo, confirmed: scenario !== "unconfirmed", keepBranch: scenario === "keep" };
        const preflight: RemoveWorktreePhase[] = [];
        const expected = await inspectRemoveWorktree(input, { ...options, onProgress: (phase) => preflight.push(phase) });
        assert.deepEqual(preflight, ["inspect"]);
        if (scenario === "dirty") await writeFile(path.join(target, "dirty.txt"), "dirty\n");
        if (scenario === "changed") git("-C", target, "switch", "-q", "-c", "feat/changed");
        const phases: RemoveWorktreePhase[] = [];
        const observations: { phase: RemoveWorktreePhase; exists: boolean; branchExists: boolean }[] = [];
        const operation = () => removeWorktree(input, { ...options, onProgress(phase) {
          phases.push(phase);
          observations.push({ phase, exists: existsSync(target), branchExists: Boolean(git("branch", "--list", "feat/target")) });
          if (scenario === "sink-failure") throw new Error("feedback unavailable");
        } }, expected);
        if (["success", "keep", "sink-failure"].includes(scenario)) {
          const result = await operation();
          assert.equal(result.worktreePath, canonicalTarget);
          assert.equal(result.branchStatus, scenario === "keep" ? "preserved" : "deleted");
          assert.deepEqual(phases, scenario === "keep" ? ["inspect", "remove", "verify"] : ["inspect", "remove", "verify", "branch-remove"]);
        } else {
          await assert.rejects(operation, (error: unknown) => {
            assert.ok(error instanceof WorktreeError);
            assert.equal(error.removalStatus, scenario === "verify-failure" ? "unverified" : scenario === "branch-failure" ? "removed" : "not-started");
            return true;
          });
          assert.deepEqual(phases, scenario === "unconfirmed" ? [] : scenario === "verify-failure" ? ["inspect", "remove", "verify"] : scenario === "branch-failure" ? ["inspect", "remove", "verify", "branch-remove"] : ["inspect"]);
          assert.equal(existsSync(target), !["verify-failure", "branch-failure"].includes(scenario));
          assert.ok(git("branch", "--list", "feat/target"));
        }
        // observer 的异常会被生产代码隔离，断言必须放在回调之外。
        for (const observation of observations) {
          assert.equal(observation.exists, observation.phase === "inspect" || observation.phase === "remove");
          assert.equal(observation.branchExists, true);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
