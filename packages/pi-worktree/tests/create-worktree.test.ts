import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createWorktree, listWorktrees, WorktreeError, validateCreateInput, type CommandRunner } from "../src/core.ts";
import type { DomainOptions } from "../src/worktree-repository.ts";
import { isLexicallyWithin, samePath } from "../src/worktree-paths.ts";
import { runPosixHook } from "../src/worktree-hook.ts";

const exec = promisify(execFile);
const posixOnly = { skip: process.platform === "win32" };
const runner: CommandRunner = {
  async run(command, args, options) {
    try {
      const result = await exec(command, args, { ...options, encoding: "utf8" });
      return { ...result, code: 0, killed: false };
    } catch (error) {
      const failed = error as Error & { code?: number; stdout?: string; stderr?: string };
      if (failed.name === "AbortError") throw error;
      return { code: typeof failed.code === "number" ? failed.code : 1,
        stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", killed: false };
    }
  },
};

async function fixture(callback: (f: {
  root: string; repo: string; target: string; options: DomainOptions;
  create: (input?: Record<string, unknown>, overrides?: Partial<DomainOptions>) => ReturnType<typeof createWorktree>;
  git: (...args: string[]) => Promise<string>;
  hook: (content: string) => Promise<string>;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "native-worktree-"));
  const repo = path.join(root, "repo space 中文");
  const target = path.join(root, "worktrees", "sample");
  const options: DomainOptions = { runner, env: { PI_CODING_AGENT_DIR: path.join(root, "agent") } };
  const git = async (...args: string[]) => (await exec("git", ["-C", repo, ...args], { encoding: "utf8" })).stdout.trim();
  try {
    await mkdir(repo);
    await git("init", "-q", "-b", "main");
    await git("config", "user.name", "fixture");
    await git("config", "user.email", "fixture@example.invalid");
    await writeFile(path.join(repo, "README.md"), "isolated fixture\n");
    await git("add", "README.md");
    await git("commit", "-qm", "init");
    await callback({ root, repo, target, options, git,
      create: (input = {}, overrides = {}) => createWorktree({ repoPath: repo, name: "sample",
        mode: "new-branch", baseRef: "main", branch: "feat/sample", ...input }, { ...options, ...overrides }),
      hook: async (content) => {
        const file = path.join(repo, ".pi", "worktree", "setup.sh");
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, content);
        return file;
      },
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

function stage(expected: WorktreeError["stage"]): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof WorktreeError);
    assert.equal(error.stage, expected);
    return true;
  };
}

// 以下覆盖原 Shell 创建器的 15 个场景，钩子场景在 Windows 改验提前拒绝。
test("native 1/2/3/8：三种创建模式、无钩子、Git 管理目录中的历史所有权格式", async () => {
  await fixture(async (f) => {
    const created = await f.create();
    assert.equal(created.branch, "feat/sample");
    assert.equal(created.setupHook.status, "skipped");
    const admin = (await exec("git", ["-C", created.worktreePath, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" })).stdout.trim();
    const marker = JSON.parse(await readFile(path.join(admin, "pi-worktree-manager.json"), "utf8"));
    assert.equal(marker.schemaVersion, 1);
    assert.equal(new Date(marker.createdAt).toISOString(), marker.createdAt);
    await assert.rejects(readFile(path.join(created.worktreePath, "pi-worktree-manager.json")));
    await f.git("branch", "feat/existing");
    assert.equal((await f.create({ name: "existing", mode: "existing-branch", branch: "feat/existing", baseRef: undefined })).branch, "feat/existing");
    assert.equal((await f.create({ name: "detached", mode: "detached", branch: undefined })).branch, undefined);
    assert.equal((await listWorktrees(f.repo, runner, f.options.env)).worktrees.length, 3);
  });
});

test("native 4/5：非法名称、路径逃逸、基准不存在或参数样式引用不产生分支", async () => {
  await fixture(async (f) => {
    for (const input of [{ name: "../escape" }, { name: "a".repeat(41) }, { baseRef: "missing" }, { baseRef: "--help" }]) {
      await assert.rejects(f.create(input), stage("validation"));
      assert.equal(await f.git("branch", "--list", "feat/sample"), "");
    }
    await assert.rejects(realpath(f.target));
  });
});

test("native refs：新分支必须不存在，已有分支必须存在，分支格式必须有效", async () => {
  await fixture(async (f) => {
    for (const input of [{ branch: "main" }, { branch: "bad..branch" },
      { mode: "existing-branch", branch: "missing", baseRef: undefined }]) {
      await assert.rejects(f.create(input), stage("validation"));
    }
    await assert.rejects(realpath(f.target));
  });
});

test("native 6：before-create 失败不留工作树或分支且不泄露输出", posixOnly, async () => {
  await fixture(async (f) => {
    await f.hook("printf 'fixture-private-output\\n' >&2\nexit 17\n");
    await assert.rejects(f.create({ setupHookApproved: true }), (error) => {
      stage("before-create")(error);
      assert.doesNotMatch(String(error), /fixture-private-output/);
      return true;
    });
    assert.equal(await f.git("branch", "--list", "feat/sample"), "");
    await assert.rejects(realpath(f.target));
  });
});

test("native 7：after-create 失败保留分支、工作树及所有权", posixOnly, async () => {
  await fixture(async (f) => {
    await f.hook('if [[ "$1" == "after-create" ]]; then exit 23; fi\n');
    await assert.rejects(f.create({ setupHookApproved: true }), stage("after-create"));
    assert.ok(await f.git("branch", "--list", "feat/sample"));
    assert.equal((await listWorktrees(f.repo, runner, f.options.env)).worktrees.length, 1);
  });
});

test("native 9/10：已存在目标和已检出分支安全失败", async () => {
  await fixture(async (f) => {
    await mkdir(f.target, { recursive: true });
    await assert.rejects(f.create(), stage("validation"));
    assert.equal(await f.git("branch", "--list", "feat/sample"), "");
    await rm(f.target, { recursive: true });
    await assert.rejects(f.create({ mode: "existing-branch", branch: "main", baseRef: undefined }), stage("git-add"));
    await assert.rejects(realpath(f.target));
  });
});

test("native 11：批准内容在 before-create 前改变则拒绝执行", posixOnly, async () => {
  await fixture(async (f) => {
    const hook = await f.hook("exit 0\n");
    let hashes = 0;
    const changingRunner: CommandRunner = { async run(command, args, options) {
      const result = await runner.run(command, args, options);
      if (args.includes("hash-object") && ++hashes === 1) await writeFile(hook, "exit 1\n");
      return result;
    } };
    await assert.rejects(f.create({ setupHookApproved: true }, { runner: changingRunner }), stage("before-create"));
    assert.equal(await f.git("branch", "--list", "feat/sample"), "");
  });
});

test("native 12：所有权失败保留工作树但不伪造成功", async () => {
  await fixture(async (f) => {
    const failing: CommandRunner = { async run(command, args, options) {
      if (args[1] === f.target && args.includes("--absolute-git-dir")) {
        return { code: 1, stdout: "", stderr: "fixture-only", killed: false };
      }
      return runner.run(command, args, options);
    } };
    await assert.rejects(f.create({}, { runner: failing }), stage("ownership"));
    assert.ok(await realpath(f.target));
    assert.ok(await f.git("branch", "--list", "feat/sample"));
    assert.equal((await listWorktrees(f.repo, runner, f.options.env)).worktrees.length, 0);
  });
});

test("native 13/14/15：隔离 HOME 的字面 ~、相对 agent 路径及默认目录", async () => {
  await fixture(async (f) => {
    const home = path.join(f.root, "home");
    await mkdir(home);
    const module = pathToFileURL(path.resolve(import.meta.dirname, "../src/core.ts")).href;
    const script = `import { createWorktree } from ${JSON.stringify(module)};
      import { execFile } from 'node:child_process'; import { promisify } from 'node:util';
      const exec = promisify(execFile); const runner = { async run(c,a) {
        try { return { ...await exec(c,a,{encoding:'utf8'}),code:0,killed:false }; }
        catch(e) { return { code:1,stdout:'',stderr:'',killed:false }; }
      }};
      const result = await createWorktree(JSON.parse(process.argv[1]),{ runner });
      process.stdout.write(result.worktreePath);`;
    for (const [name, agent] of [["tilde", "~/pi/agent"], ["relative", "relative/agent"], ["default", undefined]] as const) {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
      if (agent) env.PI_CODING_AGENT_DIR = agent;
      else delete env.PI_CODING_AGENT_DIR;
      const action = exec(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script,
        JSON.stringify({ repoPath: f.repo, name, mode: "detached", baseRef: "main" })], { cwd: f.root, env, encoding: "utf8" });
      if (name === "relative") await assert.rejects(action, /PI_CODING_AGENT_DIR/);
      else assert.equal((await action).stdout, await realpath(path.join(home, name === "tilde" ? "pi" : ".pi", "worktrees", name)));
    }
    await assert.rejects(realpath(path.join(f.root, "relative")));
    await assert.rejects(realpath(path.join(f.root, "~")));
  });
});

test("Windows setup.sh 不论是否批准均在创建任何目录/分支及执行 hook 前失败", async () => {
  await fixture(async (f) => {
    await f.hook("exit 0\n");
    let hooks = 0;
    for (const approved of [false, true]) {
      await assert.rejects(f.create({ setupHookApproved: approved }, { platform: "win32", hookRunner: async () => { hooks++; } }),
        (error) => { stage("validation")(error); assert.match(String(error), /Windows.*setup\.sh/); return true; });
    }
    assert.equal(hooks, 0);
    await assert.rejects(realpath(path.dirname(f.target)));
    assert.equal(await f.git("branch", "--list", "feat/sample"), "");
  });
});

test("Windows 设备名纯校验不改变 POSIX 合法名字；路径纯校验保持跨盘、UNC 及大小写边界", () => {
  for (const name of ["con", "prn", "aux", "nul", ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]) {
    const input = { repoPath: "/repo", name, mode: "detached" as const, baseRef: "main" };
    assert.throws(() => validateCreateInput(input, "win32"), /设备保留名/);
    assert.equal(validateCreateInput(input, "linux").name, name);
  }
  assert.equal(isLexicallyWithin("C:\\pi\\worktrees", "c:/pi/worktrees/task", path.win32), true);
  for (const target of ["D:\\pi\\worktrees\\task", "C:\\pi\\worktrees", "C:\\pi\\worktrees-other\\task", "C:\\PI\\worktrees\\task"]) {
    assert.equal(isLexicallyWithin("C:\\pi\\worktrees", target, path.win32), false, target);
  }
  assert.equal(isLexicallyWithin("\\\\server\\share\\worktrees", "\\\\server\\share\\worktrees\\task", path.win32), true);
  assert.equal(isLexicallyWithin("\\\\server\\share\\worktrees", "\\\\server\\other\\task", path.win32), false);
});

test("canonical equality 跟随 symlink/junction，真实大小写敏感目录不合并", async () => {
  await fixture(async (f) => {
    const alias = path.join(f.root, "alias");
    await symlink(f.repo, alias, process.platform === "win32" ? "junction" : "dir");
    assert.equal(samePath(alias, f.repo), true);
    const upper = path.join(f.root, "Case");
    const lower = path.join(f.root, "case");
    await mkdir(upper);
    await mkdir(lower, { recursive: true });
    const distinct = await realpath(upper) !== await realpath(lower);
    assert.equal(samePath(upper, lower), !distinct);
  });
});

test("POSIX hook 参数、环境和两阶段 cwd 保持不变", posixOnly, async () => {
  await fixture(async (f) => {
    await f.hook('printf "%s\\n" "$PWD" "$1" "$PI_WORKTREE_PHASE" "$PI_WORKTREE_SOURCE_ROOT" "$PI_WORKTREE_TARGET" "$PI_WORKTREE_BASE" "$PI_WORKTREE_BRANCH" "$PI_WORKTREE_NAME" "$PI_WORKTREE_MODE" "$PI_CODING_AGENT_DIR" > "$PWD/hook-$1.txt"\n');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const configuredAgentDir = `${f.root}${path.sep}unused${path.sep}..${path.sep}agent`;
    await f.create({ setupHookApproved: true }, { env: { PI_CODING_AGENT_DIR: configuredAgentDir } });
    for (const phase of ["before-create", "after-create"]) {
      const cwd = await realpath(phase === "before-create" ? f.repo : f.target);
      assert.deepEqual((await readFile(path.join(cwd, `hook-${phase}.txt`), "utf8")).trim().split("\n"),
        [cwd, phase, phase, await realpath(f.repo), await realpath(f.target), "main", "feat/sample", "sample", "new-branch", path.join(f.root, "agent")]);
    }
    assert.equal(process.env.PI_CODING_AGENT_DIR, previousAgentDir, "钩子环境不修改全局 process.env");
  });
});

test("POSIX after-create 前复核内容及符号链接目标", posixOnly, async () => {
  await fixture(async (f) => {
    const hook = await f.hook("exit 0\n");
    let phases = 0;
    await assert.rejects(f.create({ setupHookApproved: true }, { hookRunner: async () => {
      phases++;
      await writeFile(hook, "exit 1\n");
    } }), stage("after-create"));
    assert.equal(phases, 1);
    assert.equal((await listWorktrees(f.repo, runner, f.options.env)).worktrees.length, 1);
  });
  await fixture(async (f) => {
    const hook = await f.hook("exit 0\n");
    const first = path.join(f.root, "first.sh");
    const second = path.join(f.root, "second.sh");
    await writeFile(first, "exit 0\n");
    await writeFile(second, "exit 0\n");
    await rm(hook);
    await symlink(first, hook);
    await assert.rejects(f.create({ setupHookApproved: true }, { hookRunner: async () => {
      await rm(hook);
      await symlink(second, hook);
    } }), stage("after-create"));
  });
});

test("POSIX hook 取消传播 AbortError 且不创建工作树；大量输出不会回显或累积", posixOnly, async () => {
  await fixture(async (f) => {
    await f.hook("while true; do printf 'fixture-private-output'; done\n");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await assert.rejects(f.create({ setupHookApproved: true }, { signal: controller.signal }), { name: "AbortError" });
    } finally { clearTimeout(timer); }
    assert.equal(await f.git("branch", "--list", "feat/sample"), "");
    await assert.rejects(realpath(f.target));
  });
});

test("POSIX hook 执行错误不带入输出，启动失败也能正常结束", posixOnly, async () => {
  await fixture(async (f) => {
    await assert.rejects(runPosixHook(path.join(f.root, "missing.sh"), "before-create", { cwd: f.root, env: process.env }),
      /退出码/);
    await assert.rejects(runPosixHook("fixture", "before-create", { cwd: f.root, env: { PATH: "" } }), /无法启动/);
  });
});
