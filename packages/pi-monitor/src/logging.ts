import { existsSync } from "node:fs";
import { appendFile, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_LOG_BACKUPS, MAX_LOG_BYTES } from "./constants.ts";
import type { MonitorLogEntry, MonitorRecord } from "./types.ts";

const LOG_SEGMENTS = [".pi", "logs", "monitor"] as const;
const MAX_ROOT_DEPTH = 32;

const roots = new Map<string, string>();

/**
 * 从任务 cwd 向上找 `.git`（目录或 worktree 的占位文件），不调用 git。
 * 找不到仓库根时使用 cwd 本身；结果按 cwd 缓存，注册后不再变化。
 */
export function resolveProjectRoot(cwd: string): string {
  const cached = roots.get(cwd);
  if (cached) return cached;
  let current = path.resolve(cwd);
  let root = current;
  for (let depth = 0; depth < MAX_ROOT_DEPTH; depth++) {
    if (existsSync(path.join(current, ".git"))) { root = current; break; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  roots.set(cwd, root);
  return root;
}

function slug(name: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 40);
  return cleaned || "task";
}

export type LogSource = Pick<MonitorRecord, "id" | "name" | "cwd" | "ownerSessionId" | "logLevel">;

/** 每任务一个 JSONL 文件，路径可由 cwd、name、id 重新推导，不写入持久状态。 */
export function projectLogFile(task: Pick<MonitorRecord, "cwd" | "id" | "name">): string {
  return path.join(
    resolveProjectRoot(task.cwd), ...LOG_SEGMENTS,
    `${slug(task.name)}-${task.id.slice(0, 8)}.jsonl`,
  );
}

export interface LogOptions {
  maxBytes?: number;
  maxBackups?: number;
  now?: () => Date;
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

/**
 * 追加式任务日志。写入按文件串行排队，失败只禁用该任务日志并提醒一次，
 * 不抛出、不改变监听状态；日志不是回执或去重的真源。
 */
export class MonitorLogger {
  private disabled = new Set<string>();
  private queues = new Map<string, Promise<void>>();
  private prepared = new Map<string, Promise<void>>();
  private notify: (message: string) => void;
  private options: LogOptions;
  private now: () => Date;

  constructor(notify: (message: string) => void, options: LogOptions = {}) {
    this.notify = notify;
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  write(task: LogSource, entry: MonitorLogEntry): void {
    const level = task.logLevel;
    if (level === "off" || this.disabled.has(task.id)) return;
    if (entry.level === "debug" && level !== "debug") return;
    const line = JSON.stringify({
      ts: this.now().toISOString(), taskId: task.id, name: task.name,
      sessionId: task.ownerSessionId, ...entry,
    }) + "\n";
    const file = projectLogFile(task);
    const next = (this.queues.get(file) ?? Promise.resolve())
      .then(() => this.append(file, task.id, line))
      .catch(() => { /* append 内部已处理；保持队列可继续写入。 */ });
    this.queues.set(file, next);
  }

  /** 测试与退出前等待已排队的写入。 */
  async flush(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }

  private async append(file: string, taskId: string, line: string): Promise<void> {
    if (this.disabled.has(taskId)) return;
    const bytes = Buffer.byteLength(line);
    try {
      await this.appendLine(file, line, bytes);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") { this.disable(taskId, error); return; }
    }
    // 目录可能被外部清理（如手动 rm -rf .pi/logs）；重建后重试一次。
    this.prepared.delete(path.dirname(file));
    try { await this.appendLine(file, line, bytes); }
    catch (error) { this.disable(taskId, error); }
  }

  private async appendLine(file: string, line: string, bytes: number): Promise<void> {
    await this.prepare(path.dirname(file));
    await this.rotate(file, bytes);
    await appendFile(file, line, { mode: 0o600 });
  }

  private prepare(dir: string): Promise<void> {
    const cached = this.prepared.get(dir);
    if (cached) return cached;
    const ready = (async () => {
      await mkdir(dir, { recursive: true });
      // 日志是运行产物，不应让宿主项目的 git status 变脏；不修改项目根 .gitignore。
      try { await writeFile(path.join(path.dirname(dir), ".gitignore"), "*\n", { flag: "wx" }); } catch { /* 已存在或不可写都不影响记录。 */ }
    })();
    const guarded = ready.catch((error) => { this.prepared.delete(dir); throw error; });
    this.prepared.set(dir, guarded);
    return guarded;
  }

  private async rotate(file: string, incoming: number): Promise<void> {
    const maxBytes = this.options.maxBytes ?? MAX_LOG_BYTES;
    const backups = this.options.maxBackups ?? MAX_LOG_BACKUPS;
    let size = 0;
    try { size = (await stat(file)).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (size === 0 || size + incoming <= maxBytes) return;
    await unlink(`${file}.${backups}`).catch(ignoreMissing);
    for (let index = backups - 1; index >= 1; index--) {
      await rename(`${file}.${index}`, `${file}.${index + 1}`).catch(ignoreMissing);
    }
    await rename(file, `${file}.1`);
  }

  private disable(taskId: string, error: unknown): void {
    if (this.disabled.has(taskId)) return;
    this.disabled.add(taskId);
    try { this.notify(`监听日志写入失败，已停止记录该任务日志：${String(error).slice(0, 200)}`); } catch { /* 提醒失败不改变结果。 */ }
  }
}
