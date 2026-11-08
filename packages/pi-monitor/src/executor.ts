import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { KILL_GRACE_MS, MAX_OUTPUT_BYTES } from "./constants.ts";
import { isProcessLive, processBackend, type ProcessBackend } from "./process-backend.ts";
import { parseCheckResult } from "./protocol.ts";
import type { CheckResult, MonitorRecord } from "./types.ts";

type Command = Pick<MonitorRecord, "id" | "command" | "args" | "cwd" | "timeoutMs" | "cursor">;
const EXIT_DRAIN_MS = 1_000;
const STOP_WAIT_MS = 3_000;
const ignoreError = () => { /* 不读取 stdin 或已关闭的管道不能产生未处理错误。 */ };

export interface CommandOptions {
  backend?: ProcessBackend;
  onDiagnostic?: (message: string) => void;
}

/** 进程组/Windows 进程树仅用于生命周期清理，不是权限或资源隔离。 */
export function runCommand(task: Command, signal: AbortSignal, options: CommandOptions = {}): Promise<string> {
  if (signal.aborted) return Promise.reject(new Error("检查已取消"));
  const backend = options.backend ?? processBackend;
  try {
    const child = backend.start(task.command, task.args, task.cwd);
    return new CommandExecution(task, signal, child, backend, options.onDiagnostic).run();
  } catch (error) {
    return Promise.reject(new Error(`无法启动检查命令：${error instanceof Error ? error.message : String(error)}`));
  }
}

class CommandExecution {
  private task: Command;
  private signal: AbortSignal;
  private child: ChildProcessWithoutNullStreams;
  private backend: ProcessBackend;
  private diagnostic?: (message: string) => void;
  private stdout: Buffer[] = [];
  private stderr: Buffer[] = [];
  private bytes = 0;
  private failure?: Error;
  private settled = false;
  private exited = false;
  private code: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private deadline?: ReturnType<typeof setTimeout>;
  private pendingStop: Promise<void> = Promise.resolve();
  private windowsStopStarted = false;
  private resolve!: (value: string) => void;
  private reject!: (error: Error) => void;

  constructor(task: Command, signal: AbortSignal, child: ChildProcessWithoutNullStreams, backend: ProcessBackend, diagnostic?: (message: string) => void) {
    this.task = task;
    this.signal = signal;
    this.child = child;
    this.backend = backend;
    this.diagnostic = diagnostic;
  }

  run(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.child.stdin.on("error", ignoreError);
      this.child.stdout.on("data", this.onStdout);
      this.child.stderr.on("data", this.onStderr);
      this.child.stdout.on("error", this.onPipeError);
      this.child.stderr.on("error", this.onPipeError);
      this.child.once("error", this.onError);
      this.child.once("exit", this.onExit);
      this.child.once("close", this.onClose);
      this.signal.addEventListener("abort", this.onAbort, { once: true });
      this.deadline = this.schedule(() => this.terminate("检查命令超时"), this.task.timeoutMs);
      this.child.stdin.end(JSON.stringify({ monitorId: this.task.id, cursor: this.task.cursor ?? null }) + "\n");
      // 覆盖启动与监听 signal 之间的取消窗口。
      if (this.signal.aborted) this.onAbort();
    });
  }

  private schedule(callback: () => void, delay: number) {
    const timer = setTimeout(callback, delay);
    this.timers.add(timer);
    return timer;
  }

  private report(message: string): void {
    try { this.diagnostic?.(message); } catch { /* 诊断失败不影响检查收口。 */ }
  }

  private stop(signal: NodeJS.Signals): void {
    if (this.backend.platform === "win32") {
      if (this.windowsStopStarted || this.exited || !isProcessLive(this.child)) return;
      this.windowsStopStarted = true;
    }
    try {
      this.pendingStop = Promise.resolve(this.backend.stop(this.child, signal)).catch((error) => {
        this.report(error instanceof Error ? error.message : "检查进程清理失败，后代进程可能残留");
        if (isProcessLive(this.child)) {
          try { this.child.kill("SIGKILL"); } catch { /* best-effort 回收不保证成功。 */ }
        }
      });
    } catch {
      this.report("检查进程清理失败，后代进程可能残留");
    }
  }

  private terminate(message: string): void {
    if (this.failure || this.settled) return;
    this.failure = new Error(message);
    this.stop(this.backend.platform === "win32" ? "SIGKILL" : "SIGTERM");
    if (this.backend.platform !== "win32") this.schedule(() => this.stop("SIGKILL"), KILL_GRACE_MS);
    this.schedule(() => {
      this.report("检查未能确认退出，已停止等待；后代进程可能残留");
      this.finish();
    }, STOP_WAIT_MS);
  }

  private collect(parts: Buffer[], chunk: Buffer): void {
    if (this.settled) return;
    this.bytes += chunk.length;
    if (this.bytes > MAX_OUTPUT_BYTES) {
      this.terminate(`检查输出超过 ${MAX_OUTPUT_BYTES} 字节上限（stdout 与 stderr 合计）`);
      return;
    }
    parts.push(chunk);
  }

  private onStdout = (chunk: Buffer) => this.collect(this.stdout, chunk);
  private onStderr = (chunk: Buffer) => this.collect(this.stderr, chunk);
  private onPipeError = () => this.terminate("读取检查输出失败");
  private onAbort = () => this.terminate("检查已取消");
  private onError = (error: Error) => {
    this.failure ??= new Error(`无法启动检查命令：${error.message}`);
    this.finish();
  };

  private onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    this.exited = true;
    this.code = code;
    this.exitSignal = signal;
    if (this.deadline) clearTimeout(this.deadline);
    // POSIX 在组长退出后仍可回收同组后代；Windows 不向已退出根进程的旧 PID 发起补杀。
    if (this.backend.platform !== "win32") this.stop("SIGKILL");
    this.schedule(() => {
      this.failure ??= new Error("检查主进程已退出，但输出管道未关闭；后代进程可能残留");
      this.report(this.failure.message);
      this.finish();
    }, EXIT_DRAIN_MS);
  };

  private onClose = (code: number | null, signal: NodeJS.Signals | null) => {
    this.code = code;
    this.exitSignal = signal;
    this.finish();
  };

  private finish(): void {
    if (this.settled) return;
    this.settled = true;
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.signal.removeEventListener("abort", this.onAbort);
    this.child.removeListener("error", this.onError);
    this.child.on("error", ignoreError);
    this.child.removeListener("exit", this.onExit);
    this.child.removeListener("close", this.onClose);
    this.child.stdout.removeListener("data", this.onStdout);
    this.child.stderr.removeListener("data", this.onStderr);
    this.child.stdout.removeListener("error", this.onPipeError);
    this.child.stderr.removeListener("error", this.onPipeError);
    this.child.stdout.on("error", ignoreError);
    this.child.stderr.on("error", ignoreError);
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    this.child.unref();
    void this.pendingStop.then(() => {
      if (this.failure) return this.reject(this.failure);
      if (this.code !== 0) {
        const diagnostic = Buffer.concat(this.stderr).toString("utf8").slice(0, 1_000);
        return this.reject(new Error(`检查命令退出：${this.code ?? this.exitSignal}${diagnostic ? `；${diagnostic}` : ""}`));
      }
      this.resolve(Buffer.concat(this.stdout).toString("utf8"));
    });
  }
}

export async function executeCheck(task: MonitorRecord, signal: AbortSignal, onDiagnostic?: (message: string) => void): Promise<CheckResult> {
  return parseCheckResult(await runCommand(task, signal, { onDiagnostic }));
}
