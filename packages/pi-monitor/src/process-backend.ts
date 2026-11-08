import { spawn as spawnNative, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import spawn from "cross-spawn";

export const TREE_KILL_TIMEOUT_MS = 2_000;

export interface ProcessBackend {
  platform: NodeJS.Platform;
  start(command: string, args: string[], cwd: string): ChildProcessWithoutNullStreams;
  stop(child: ChildProcess, signal: NodeJS.Signals): void | Promise<void>;
}

type TerminatorSpawner = (command: string, args: string[]) => ChildProcess;

export function isProcessLive(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

/** 不缓存 PID；退出后无法可靠追溯后代，也不能用旧 PID 重试。 */
export function terminateWindowsTree(
  child: ChildProcess,
  spawnTerminator: TerminatorSpawner = (command, args) => spawnNative(command, args, { windowsHide: true, stdio: "ignore" }),
  timeoutMs = TREE_KILL_TIMEOUT_MS,
  systemRoot = process.env.SystemRoot || "C:\\Windows",
): Promise<void> {
  if (!isProcessLive(child)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let terminator: ChildProcess;
    try {
      terminator = spawnTerminator(path.win32.join(systemRoot, "System32", "taskkill.exe"), ["/T", "/F", "/PID", String(child.pid)]);
    } catch {
      reject(new Error("无法启动 Windows 检查进程树清理，后代进程可能残留"));
      return;
    }
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminator.removeListener("exit", onExit);
      // 保留 error 监听到对象释放，避免超时后迟到的启动错误成为未处理事件。
      if (error) reject(error);
      else resolve();
    };
    const onExit = (code: number | null) => finish(code === 0 ? undefined : new Error(`Windows 检查进程树清理失败（退出码 ${code ?? "未知"}），后代进程可能残留`));
    const timer = setTimeout(() => {
      try { terminator.kill("SIGKILL"); } catch { /* 清理器自身失败不能无限阻塞检查。 */ }
      terminator.unref();
      finish(new Error("Windows 检查进程树清理超时，后代进程可能残留"));
    }, timeoutMs);
    terminator.on("error", () => finish(new Error("无法启动 Windows 检查进程树清理，后代进程可能残留")));
    terminator.once("exit", onExit);
  });
}

function signalPosixGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    if (isProcessLive(child)) child.kill(signal);
  }
}

export const processBackend: ProcessBackend = {
  platform: process.platform,
  start(command, args, cwd) {
    return spawn(command, args, {
      cwd, shell: false, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
  },
  stop(child, signal) {
    return process.platform === "win32" ? terminateWindowsTree(child) : signalPosixGroup(child, signal);
  },
};
