import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listWorktrees, type CommandRunner } from "../src/core.ts";
import { collectWorkspaceChoices, registerWorktreeSwitch } from "../src/worktree-switch.ts";
import { samePath } from "../src/worktree-paths.ts";

const runner: CommandRunner = { async run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, killed: false };
} };

test("隔离 Git 工作区的 canonical 选择与原生会话恢复", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-switch-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const repo = path.join(root, "repo");
    const agentDir = path.join(repo, ".pi", "agent");
    const sessions = path.join(root, "sessions");
    const linked = path.join(repo, ".pi", "worktrees", "linked");
    const alias = path.join(root, "linked-alias");
    await mkdir(repo);
    await mkdir(agentDir, { recursive: true });
    await mkdir(sessions);
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
    await symlink(linked, alias, process.platform === "win32" ? "junction" : "dir");
    await mkdir(path.join(repo, "src"));
    await mkdir(path.join(linked, "src"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const mainPath = await realpath(repo);
    const linkedPath = await realpath(linked);
    const histories = new Map<string, { file: string; id: string }>();
    for (const [index, cwd] of [mainPath, linkedPath].entries()) {
      const id = `33333333-3333-7333-8333-33333333333${index}`;
      const file = path.join(sessions, `${index}.jsonl`);
      await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: new Date().toISOString() })}\n`);
      histories.set(cwd, { file: await realpath(file), id });
    }
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
        if (args.includes("--porcelain")) result.stdout = result.stdout.split("\0").map((token) =>
          token.startsWith("worktree ") && samePath(token.slice(9), linkedPath) ? `worktree ${alias}` : token).join("\0");
        return result;
      } };
      assert.equal((await listWorktrees(repo, aliasRunner)).worktrees[0].path, alias);
      const choices = await collectWorkspaceChoices(path.join(alias, "src"), aliasRunner);
      assert.deepEqual(choices.map((choice) => choice.path), [mainPath, linkedPath]);
      assert.deepEqual(choices.filter((choice) => choice.current).map((choice) => choice.path), [linkedPath]);
      assert.ok(choices[1].label.includes(linkedPath));
      assert.ok(!choices[1].label.includes(alias));
    });
    const makeCommand = (cwd: string, target: string) => {
      const f = fixture(runner);
      const history = histories.get(target)!;
      let switches = 0;
      let waits = 0;
      let locks = 0;
      const ctx = {
        cwd, mode: "rpc", isIdle: () => true, waitForIdle: async () => { waits++; },
        sessionManager: { getSessionFile: (): string | undefined => undefined, getSessionId: () => "ephemeral",
          getSessionDir: () => sessions, getHeader: (): { parentSession?: string } | undefined => undefined },
        ui: { notify: (text: string) => f.notices.push(text), select: async (_title: string, _labels: string[]) => undefined as string | undefined },
        switchSession: async (file: string, options: any) => {
          switches++;
          assert.equal(file, history.file);
          await options.withSession({ cwd: target, ui: ctx.ui,
            sessionManager: { getSessionFile: () => file, getSessionId: () => history.id },
            sendMessage: () => { throw new Error("manual switch must not resume"); } });
          return { cancelled: false };
        },
      };
      registerWorktreeSwitch(f.pi as never, runner, async (operation) => { locks++; return operation(); }, (error) => f.errors.push(error));
      return { f, ctx, counts: () => [switches, waits, locks] };
    };
    await t.test("空白/内存源恢复原文件；linked 返回主根、子目录进入所属根、精确根 no-op", async () => {
      for (const [cwd, target, expected] of [
        [linked, mainPath, 1], [path.join(repo, "src"), mainPath, 1],
        [path.join(linked, "src"), linkedPath, 1], [repo, mainPath, 0],
        [linked, linkedPath, 0], [alias, linkedPath, 0],
      ] as const) {
        const { f, ctx, counts } = makeCommand(cwd, target);
        await f.command().handler(JSON.stringify({ worktreePath: target }), ctx);
        assert.deepEqual(f.errors, [], `${cwd} -> ${target}`);
        assert.deepEqual(counts(), [expected, expected, expected], `${cwd} -> ${target}`);
      }
    });
    await t.test("显式完整 ID 可在当前根恢复另一会话；同 ID no-op；跨目标和短 ID 拒绝", async () => {
      const { f, ctx, counts } = makeCommand(mainPath, mainPath);
      const input = { worktreePath: mainPath, sessionId: histories.get(mainPath)!.id };
      await f.command().handler(JSON.stringify(input), ctx);
      assert.deepEqual(counts(), [1, 1, 1]);
      ctx.sessionManager.getSessionId = () => input.sessionId;
      await f.command().handler(JSON.stringify(input), ctx);
      assert.deepEqual(counts(), [1, 1, 1]);
      for (const sessionId of [histories.get(linkedPath)!.id, input.sessionId.slice(0, 8), ` ${input.sessionId}`]) {
        await f.command().handler(JSON.stringify({ ...input, sessionId }), ctx);
        assert.match(String(f.errors.at(-1)), /sessionId.*目标/);
      }
      assert.deepEqual(counts(), [1, 1, 1]);
    });
    await t.test("多个历史 RPC 必须指定 ID；TUI 按最近消息排序、取消保持源", async () => {
      const recentId = "44444444-4444-7444-8444-444444444444";
      await writeFile(path.join(sessions, "recent.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: recentId,
        cwd: mainPath, timestamp: "2020-01-01T00:00:00.000Z" })}\n${JSON.stringify({ type: "message", id: "entry", parentId: null,
        timestamp: "2099-01-01T00:00:00.000Z", message: { role: "user", content: "recent", timestamp: Date.parse("2099-01-01") } })}\n`);
      const { f, ctx, counts } = makeCommand(linkedPath, mainPath);
      await f.command().handler(JSON.stringify({ worktreePath: mainPath }), ctx);
      assert.match(String(f.errors.pop()), /sessionId/);
      ctx.mode = "tui";
      ctx.ui.select = async (_title, labels) => { assert.match(labels[0], /recent.*44444444/); return undefined; };
      await f.command().handler(JSON.stringify({ worktreePath: mainPath }), ctx);
      assert.deepEqual(f.errors, []);
      assert.deepEqual(counts(), [0, 0, 0]);
      await rm(path.join(sessions, "recent.jsonl"));
    });
    await t.test("迁移后的 sessionDir 已变化，仍从原生 parentSession 找回自定义源历史", async () => {
      const { f, ctx, counts } = makeCommand(linkedPath, mainPath);
      ctx.sessionManager.getSessionDir = () => "";
      ctx.sessionManager.getHeader = () => ({ parentSession: histories.get(mainPath)!.file });
      ctx.sessionManager.getSessionFile = () => path.join(root, "missing-source.jsonl");
      await f.command().handler(JSON.stringify({ worktreePath: mainPath }), ctx);
      assert.deepEqual(f.errors, []);
      assert.deepEqual(counts(), [1, 1, 1]);
    });
    await t.test("无历史（包括缺 cwd 的 legacy header）不切换", async () => {
      await rm(histories.get(mainPath)!.file);
      await writeFile(path.join(sessions, "legacy.jsonl"), `${JSON.stringify({ type: "session", id: "legacy", timestamp: new Date().toISOString() })}\n`);
      const { f, ctx, counts } = makeCommand(linkedPath, mainPath);
      await f.command().handler(JSON.stringify({ worktreePath: mainPath }), ctx);
      assert.deepEqual(f.errors, []);
      assert.match(f.notices[0], /没有可恢复/);
      assert.deepEqual(counts(), [0, 0, 0]);
    });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

function fixture(commandRunner: CommandRunner = { run: async () => { throw new Error("unexpected git"); } }) {
  let command: any;
  const errors: unknown[] = [];
  const notices: string[] = [];
  const pi = {
    on: () => {},
    registerCommand: (name: string, value: any) => { assert.equal(name, "worktree:switch"); command = value; },
    registerShortcut: () => { throw new Error("快捷键应已移除"); },
    sendUserMessage: () => { throw new Error("手动恢复不能请求模型"); },
  };
  registerWorktreeSwitch(pi as never, commandRunner, async (operation) => operation(), (error) => errors.push(error));
  const ctx = { isIdle: () => true, mode: "rpc", ui: { notify: (text: string) => notices.push(text) } };
  return { command: () => command, pi, errors, notices, ctx };
}

test("忙碌时命令只提示，不收集参数或启动恢复；不注册快捷键", async () => {
  const f = fixture();
  f.ctx.isIdle = () => false;
  await f.command().handler("", f.ctx);
  assert.equal(f.errors.length, 0);
  assert.match(f.notices[0], /本轮结束后/);
});

test("非 TUI 无参数与不合法 JSON 参数在 Git 操作前明确拒绝", async () => {
  for (const input of ["", "{", "null", "[]", "{}", '{"worktreePath":1}', '{"worktreePath":" "}',
    '{"repoPath":null,"worktreePath":"/target"}', '{"worktreePath":"/target","continueTask":true}',
    '{"worktreePath":"/target","sessionId":1}', '{"worktreePath":"/target","sessionId":" "}']) {
    const f = fixture();
    await f.command().handler(input, f.ctx);
    assert.equal(f.errors.length, 1, input);
    assert.doesNotMatch(String(f.errors[0]), /unexpected/);
  }
});
