import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listWorktrees, type CommandRunner } from "../src/core.ts";
import { collectWorkspaceChoices, registerWorktreeSwitch } from "../src/worktree-switch.ts";

test("隔离 Git 工作区的 canonical 选择、嵌套归属与精确 cwd 切换", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-switch-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const repo = path.join(root, "repo");
    const agentDir = path.join(repo, ".pi", "agent");
    const linked = path.join(repo, ".pi", "worktrees", "linked");
    const alias = path.join(root, "linked-alias");
    await mkdir(agentDir, { recursive: true });
    const runGit = (...args: string[]) => {
      const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    runGit("init", "-q", "-b", "main");
    runGit("config", "user.name", "tester");
    runGit("config", "user.email", "tester@example.com");
    await writeFile(path.join(repo, "README.md"), "fixture\n");
    runGit("add", "README.md");
    runGit("commit", "-qm", "init");
    runGit("worktree", "add", "-q", "-b", "feat/linked", linked, "main");
    const gitDir = runGit("-C", linked, "rev-parse", "--absolute-git-dir");
    await writeFile(path.join(gitDir, "pi-worktree-manager.json"), JSON.stringify({
      schemaVersion: 1, createdAt: new Date().toISOString(),
    }));
    await symlink(linked, alias, "dir");
    await mkdir(path.join(repo, "src"));
    await mkdir(path.join(linked, "src"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const mainPath = await realpath(repo);
    const linkedPath = await realpath(linked);
    const runner: CommandRunner = { async run(command, args) {
      const result = spawnSync(command, args, { encoding: "utf8" });
      if (result.error) throw result.error;
      return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, killed: false };
    } };
    await t.test("嵌套 linked 和主工作区只标记 Git 所属的唯一 current", async () => {
      for (const cwd of [linked, path.join(linked, "src"), repo, path.join(repo, "src")]) {
        const choices = await collectWorkspaceChoices(cwd, runner);
        assert.equal(choices.length, 2);
        assert.deepEqual(choices.filter((choice) => choice.current).map((choice) => choice.path),
          [cwd === repo || cwd === path.join(repo, "src") ? mainPath : linkedPath]);
      }
    });
    await t.test("仅选择 helper 归一化登记路径别名，公共 list 保持原路径", async () => {
      const aliasRunner: CommandRunner = { async run(command, args, options) {
        const result = await runner.run(command, args, options);
        if (args.includes("--porcelain")) result.stdout = result.stdout.replace(`worktree ${linkedPath}\0`, `worktree ${alias}\0`);
        return result;
      } };
      assert.equal((await listWorktrees(repo, aliasRunner)).worktrees[0].path, alias);
      const choices = await collectWorkspaceChoices(path.join(alias, "src"), aliasRunner);
      assert.deepEqual(choices.map((choice) => choice.path), [mainPath, linkedPath]);
      assert.deepEqual(choices.filter((choice) => choice.current).map((choice) => choice.path), [linkedPath]);
      assert.ok(choices[1].label.includes(linkedPath));
      assert.ok(!choices[1].label.includes(alias));
    });
    await t.test("linked 返回主根、子目录进入所属根会切换，完全相同或别名根才 no-op", async () => {
      for (const [cwd, target, expected] of [
        [linked, mainPath, 1], [path.join(repo, "src"), mainPath, 1],
        [path.join(linked, "src"), linkedPath, 1], [repo, mainPath, 0],
        [linked, linkedPath, 0], [alias, linkedPath, 0],
      ] as const) {
        let command: any;
        let forks = 0;
        let switches = 0;
        let waits = 0;
        let locks = 0;
        const errors: unknown[] = [];
        const ctx = {
          cwd, mode: "rpc", isIdle: () => true, waitForIdle: async () => { waits++; },
          sessionManager: { getSessionFile: () => "/sessions/source.jsonl" },
          ui: { notify: () => {} },
          switchSession: async (_file: string, options: any) => {
            switches++;
            await options.withSession({ cwd: target, ui: ctx.ui,
              sendMessage: () => { throw new Error("manual switch must not resume"); } });
            return { cancelled: false };
          },
        };
        registerWorktreeSwitch({
          on: () => {},
          registerCommand: (_name: string, value: any) => { command = value; },
          registerShortcut: () => {}, sendUserMessage: () => { throw new Error("unexpected model request"); },
        } as never, runner, { forkFrom: () => {
          forks++;
          return { getSessionFile: () => "/sessions/migrated.jsonl" };
        } }, async (operation) => { locks++; return operation(); }, (error) => errors.push(error));
        await command.handler(JSON.stringify({ worktreePath: target }), ctx);
        assert.deepEqual(errors, [], `${cwd} -> ${target}`);
        assert.deepEqual([forks, switches, waits, locks], [expected, expected, expected, expected], `${cwd} -> ${target}`);
      }
    });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

function fixture() {
  let command: any;
  let shortcut: any;
  const dispatches: any[] = [];
  const errors: unknown[] = [];
  const notices: string[] = [];
  const pi = {
    on: () => {},
    registerCommand: (name: string, value: any) => { assert.equal(name, "worktree:switch"); command = value; },
    registerShortcut: (key: string, value: any) => { assert.equal(key, "ctrl+alt+w"); shortcut = value; },
    sendUserMessage: (...args: any[]) => dispatches.push(args),
  };
  registerWorktreeSwitch(pi as never,
    { run: async () => { throw new Error("unexpected git"); } },
    { forkFrom: () => { throw new Error("unexpected fork"); } },
    async (operation) => operation(), (error) => errors.push(error));
  const ctx = { isIdle: () => true, mode: "rpc", ui: { notify: (text: string) => notices.push(text) } };
  return { command, shortcut, dispatches, errors, notices, ctx };
}

test("快捷键只在 idle 时通过官方命令派发，不伪造 command context", async () => {
  const f = fixture();
  f.ctx.isIdle = () => false;
  await f.shortcut.handler(f.ctx);
  assert.equal(f.dispatches.length, 0);
  assert.match(f.notices[0], /本轮结束后/);
  f.ctx.isIdle = () => true;
  await f.shortcut.handler(f.ctx);
  assert.deepEqual(f.dispatches, [["/worktree:switch", { expandPromptTemplates: true }]]);
});

test("忙碌时命令只提示，不收集参数或启动迁移", async () => {
  const f = fixture();
  f.ctx.isIdle = () => false;
  await f.command.handler("", f.ctx);
  assert.equal(f.errors.length, 0);
  assert.match(f.notices[0], /本轮结束后/);
});

test("非 TUI 无参数与不合法 JSON 参数在 Git 操作前明确拒绝", async () => {
  for (const input of ["", "{", "null", "[]", "{}", '{"worktreePath":1}', '{"worktreePath":" "}',
    '{"repoPath":null,"worktreePath":"/target"}', '{"worktreePath":"/target","continueTask":true}']) {
    const f = fixture();
    await f.command.handler(input, f.ctx);
    assert.equal(f.errors.length, 1, input);
    assert.doesNotMatch(String(f.errors[0]), /unexpected/);
    assert.equal(f.dispatches.length, 0);
  }
});
