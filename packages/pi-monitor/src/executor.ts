import { spawn } from "node:child_process";
import { KILL_GRACE_MS, MAX_OUTPUT_BYTES } from "./constants.ts";
import { parseCheckResult } from "./protocol.ts";
import type { CheckResult, MonitorRecord } from "./types.ts";

type Command = Pick<MonitorRecord, "id" | "command" | "args" | "cwd" | "timeoutMs" | "cursor">;

/** 独立进程组仅用于回收检查及其子进程，不是权限隔离。 */
export function runCommand(task: Command, signal: AbortSignal): Promise<string> {
  if (process.platform === "win32") return Promise.reject(new Error("monitor 第一版执行器仅支持 macOS/Linux"));
  if (signal.aborted) return Promise.reject(new Error("检查已取消"));
  return new Promise((resolve, reject) => {
    const child = spawn(task.command, task.args, {
      cwd: task.cwd, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (signalName: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signalName); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signalName); }
    };
    const terminate = (message: string) => {
      if (failure || settled) return;
      failure = new Error(message);
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
    };
    const abort = () => terminate("检查已取消");
    const timer = setTimeout(() => terminate("检查命令超时"), task.timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    // 不把配置/凭据写进 argv；检查脚本可从 stdin 读取增量检查点。
    child.stdin.on("error", () => { /* 不读取 stdin 的检查命令可正常退出。 */ });
    child.stdin.end(JSON.stringify({ monitorId: task.id, cursor: task.cursor ?? null }) + "\n");
    const collect = (parts: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        terminate(`检查输出超过 ${MAX_OUTPUT_BYTES} 字节上限（stdout 与 stderr 合计）`);
        return;
      }
      parts.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
    };
    child.on("error", (error) => {
      if (settled) return;
      cleanup();
      killGroup("SIGKILL");
      reject(new Error(`无法启动检查命令：${error.message}`));
    });
    child.on("exit", () => {
      // 主命令退出后不允许留下继承管道、脱离检查生命周期的后代。
      killGroup("SIGKILL");
    });
    child.on("close", (code, exitSignal) => {
      if (settled) return;
      cleanup();
      killGroup("SIGKILL");
      if (failure) return reject(failure);
      if (code !== 0) {
        const diagnostic = Buffer.concat(stderr).toString("utf8").slice(0, 1_000);
        return reject(new Error(`检查命令退出：${code ?? exitSignal}${diagnostic ? `；${diagnostic}` : ""}`));
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
    // 监听注册后再次核对，覆盖 spawn 与注册 signal 之间的取消。
    if (signal.aborted) abort();
  });
}

export async function executeCheck(task: MonitorRecord, signal: AbortSignal): Promise<CheckResult> {
  return parseCheckResult(await runCommand(task, signal));
}
