import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { WorktreeError, type CommandRunner } from "./worktree-types.ts";
import { runChecked } from "./worktree-repository.ts";
import { samePath } from "./worktree-paths.ts";

export interface SetupHook {
  setupHookPath?: string;
  setupHookResolvedPath?: string;
  setupHookBlobId?: string;
}

export interface HookRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}
export type HookRunner = (hookPath: string, phase: string, options: HookRunOptions) => Promise<void>;

export async function inspectSetupHook(
  hookPath: string, runner: CommandRunner, platform: NodeJS.Platform,
): Promise<SetupHook> {
  let stat: Stats;
  try { stat = await lstat(hookPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  // 必须在工作树根目录 mkdir、审批及 Git add 之前拒绝；不探测 Windows 的 Bash。
  if (platform === "win32") {
    throw new WorktreeError(`Windows 不支持项目工作树钩子 .pi/worktree/setup.sh：${hookPath}；尚未创建工作树或执行钩子`, "validation");
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new WorktreeError(`项目工作树钩子不是普通文件：${hookPath}`, "validation");
  }
  let resolved: string;
  try {
    resolved = await realpath(hookPath);
    if (!(await lstat(resolved)).isFile()) throw new Error("not a file");
  } catch {
    throw new WorktreeError(`项目工作树钩子符号链接无法解析为普通文件：${hookPath}`, "validation");
  }
  const result = await runChecked(runner, "git", ["hash-object", hookPath],
    `无法计算项目工作树钩子内容标识：${hookPath}`, "validation");
  const blob = result.stdout.trim();
  if (!blob) throw new WorktreeError("项目工作树钩子内容标识为空", "validation");
  return { setupHookPath: hookPath, setupHookResolvedPath: resolved, setupHookBlobId: blob };
}

export async function verifySetupHook(hook: SetupHook, runner: CommandRunner): Promise<void> {
  const current = await inspectSetupHook(hook.setupHookPath!, runner, process.platform);
  if (!current.setupHookResolvedPath || !samePath(current.setupHookResolvedPath, hook.setupHookResolvedPath!)
    || current.setupHookBlobId !== hook.setupHookBlobId) {
    throw new Error("项目工作树钩子在批准后发生变化，拒绝执行");
  }
}

const HOOK_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 1_000;

/** 输出直接丢弃，既不累计内存也不把钩子秘密带入异常；取消会终止整个 POSIX 进程组。 */
export const runPosixHook: HookRunner = async (hookPath, phase, options) => {
  options.signal?.throwIfAborted();
  if (process.platform === "win32") throw new Error("Windows 不支持 setup.sh");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bash", [hookPath, phase], {
      cwd: options.cwd, env: options.env, stdio: "ignore", detached: true,
    });
    let failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS);
      escalation.unref();
    };
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch { /* 进程组可能已经退出。 */ }
    };
    const abort = () => stop(Object.assign(new Error("项目工作树钩子已取消"), { name: "AbortError" }));
    const timer = setTimeout(() => stop(new Error("项目工作树钩子执行超时")), HOOK_TIMEOUT_MS);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.once("error", () => { failure ??= new Error("无法启动项目工作树钩子"); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (escalation) {
        // shell 先退出时仍清理忽略 SIGTERM 的后代，避免取消留下后台进程。
        kill("SIGKILL");
        clearTimeout(escalation);
      }
      options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`项目工作树钩子退出码 ${code}`));
      else resolve();
    });
  });
};
