import { randomUUID } from "node:crypto";
import {
  MAX_BACKOFF_MS, MAX_CONCURRENT, MAX_FAILURES, MAX_PENDING_BATCHES, MAX_SEEN_IDS, MAX_TIMER_MS,
} from "./constants.ts";
import { retainRecords } from "./retention.ts";
import type {
  CheckResult, EngineOptions, LogAction, MonitorDefinition, MonitorLogEntry, MonitorRecord, MonitorStatus,
} from "./types.ts";

const STATUS_ACTION: Record<MonitorStatus, LogAction> = {
  running: "resume", paused: "pause", stopped: "stop", completed: "complete", expired: "expire",
};

interface Operation { controller: AbortController; valid: boolean }

export class MonitorEngine {
  private tasks = new Map<string, MonitorRecord>();
  private operations = new Map<string, Operation>();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private persistenceBlocked = new Set<string>();
  private options: EngineOptions;
  private now: () => number;

  constructor(options: EngineOptions) { this.options = options; this.now = options.now ?? Date.now; }
  get records(): MonitorRecord[] { return structuredClone([...this.tasks.values()]); }
  get checkingIds(): ReadonlySet<string> { return new Set(this.operations.keys()); }
  get(id: string): MonitorRecord | undefined {
    const task = this.tasks.get(id);
    return task ? structuredClone(task) : undefined;
  }

  restore(records: MonitorRecord[], autoResume: (record: MonitorRecord) => boolean): void {
    if (this.disposed || this.tasks.size) throw new Error("不能重复恢复监听引擎");
    for (const snapshot of retainRecords(records)) {
      const record = structuredClone(snapshot);
      record.nextCheckAt = Math.max(record.nextCheckAt, this.now());
      this.tasks.set(record.id, record);
      if ((record.status === "running" || (record.status === "paused" && (!record.resumeStatus || record.resumeStatus === "running"))) && this.expired(record)) {
        this.commit({ ...record, status: "expired" });
      } else if (record.status === "running" && !autoResume(record)) {
        this.commit({ ...record, status: "paused", pauseReason: "重新进入会话，需要调用 resume 恢复" });
      }
    }
    this.schedule();
  }

  add(definition: MonitorDefinition): MonitorRecord {
    this.assertLive();
    if (this.tasks.has(definition.id)) throw new Error("监听 id 已存在");
    const record: MonitorRecord = {
      ...structuredClone(definition), status: this.expired(definition) ? "expired" : "running",
      nextCheckAt: this.now(), failures: 0, seenIds: [], pending: [],
    };
    this.options.save(structuredClone(record));
    this.tasks.set(record.id, record);
    this.pruneRetired();
    this.notify();
    this.schedule();
    return structuredClone(record);
  }

  stop(id: string): void {
    const task = this.require(id);
    if (task.status === "stopped") return;
    this.cancel(id);
    this.commit({ ...task, status: "stopped", pauseReason: undefined, resumeStatus: undefined });
    this.schedule();
  }

  pause(id: string, reason: string): void {
    const task = this.require(id);
    if (task.status !== "running") return;
    this.cancel(id);
    this.commit({ ...task, status: "paused", pauseReason: reason });
    this.schedule();
  }

  resume(id: string): void {
    const task = this.require(id);
    if (task.status !== "paused") throw new Error("只能恢复暂停的监听任务");
    const status = task.resumeStatus ?? "running";
    if (status !== "running") this.commit({ ...task, status, resumeStatus: undefined, pauseReason: undefined, lastError: undefined });
    else if (this.expired(task)) this.commit({ ...task, status: "expired", resumeStatus: undefined });
    else this.commit({ ...task, status: "running", resumeStatus: undefined, pauseReason: undefined, failures: 0, lastError: undefined, nextCheckAt: this.now() });
    this.schedule();
  }

  acknowledge(id: string, batchIds: string[]): void {
    const task = this.require(id);
    const ids = new Set(batchIds);
    const pending = task.pending.filter((batch) => !ids.has(batch.id));
    if (pending.length === task.pending.length) return;
    this.commit({ ...task, pending });
    this.schedule();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const id of this.operations.keys()) this.cancel(id);
  }

  private assertLive(): void { if (this.disposed) throw new Error("监听引擎已释放"); }
  private require(id: string): MonitorRecord {
    this.assertLive();
    const task = this.tasks.get(id);
    if (!task) throw new Error(`找不到监听任务：${id}`);
    return task;
  }
  private expired(task: Pick<MonitorDefinition, "deadlineAt">): boolean {
    return task.deadlineAt !== undefined && task.deadlineAt <= this.now();
  }
  private cancel(id: string): void {
    const operation = this.operations.get(id);
    if (!operation) return;
    operation.valid = false;
    operation.controller.abort();
  }
  private notify(): void {
    if (this.disposed) return;
    try { this.options.changed(); } catch { /* UI/投递失败不得破坏检查调度或回滚已提交状态。 */ }
  }

  private pruneRetired(): void {
    const kept = new Set(retainRecords(this.tasks.values()).map((task) => task.id));
    for (const id of this.tasks.keys()) if (!kept.has(id)) this.tasks.delete(id);
  }

  private commit(next: MonitorRecord): boolean {
    if (this.disposed) return false;
    const prior = this.tasks.get(next.id);
    try { this.options.save(structuredClone(next)); }
    catch (error) {
      const previous = this.tasks.get(next.id);
      if (previous) {
        this.persistenceBlocked.add(next.id);
        this.cancel(next.id);
        this.tasks.set(next.id, {
          ...previous, status: "paused", pauseReason: "状态保存失败，请检查会话存储后恢复",
          resumeStatus: previous.resumeStatus ?? (previous.status === "paused" ? "running" : previous.status),
          lastError: String(error).slice(0, 1_000),
        });
        this.log(this.tasks.get(next.id)!, {
          action: "pause", previous: previous.status, reason: "状态保存失败，请检查会话存储后恢复",
          error: String(error).slice(0, 500),
        });
      }
      this.notify();
      return false;
    }
    this.persistenceBlocked.delete(next.id);
    this.tasks.delete(next.id);
    this.tasks.set(next.id, next);
    this.pruneRetired();
    if (prior && prior.status !== next.status) {
      this.log(next, {
        action: STATUS_ACTION[next.status], previous: prior.status,
        ...(next.pauseReason ? { reason: next.pauseReason } : {}),
      });
    }
    this.notify();
    return true;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed) return;
    let due = Infinity;
    const available = this.operations.size < (this.options.maxConcurrent ?? MAX_CONCURRENT);
    for (const task of this.tasks.values()) {
      if (this.persistenceBlocked.has(task.id) || (task.status !== "running" && task.status !== "paused")) continue;
      if (task.deadlineAt !== undefined && (!task.resumeStatus || task.resumeStatus === "running")) due = Math.min(due, task.deadlineAt);
      if (task.status === "running" && available && !this.operations.has(task.id)) due = Math.min(due, task.nextCheckAt);
    }
    if (!Number.isFinite(due)) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, Math.min(MAX_TIMER_MS, Math.max(0, due - this.now())));
  }

  private pump(): void {
    if (this.disposed) return;
    for (const task of this.tasks.values()) {
      if (this.persistenceBlocked.has(task.id) || (task.status !== "running" && task.status !== "paused")) continue;
      if ((!task.resumeStatus || task.resumeStatus === "running") && this.expired(task)) {
        this.cancel(task.id);
        this.commit({ ...task, status: "expired", pauseReason: undefined });
      }
    }
    for (const task of this.tasks.values()) {
      if (this.operations.size >= (this.options.maxConcurrent ?? MAX_CONCURRENT)) break;
      if (task.status !== "running" || task.nextCheckAt > this.now() || this.operations.has(task.id)) continue;
      this.launch(task);
    }
    this.schedule();
  }

  private launch(task: MonitorRecord): void {
    const operation: Operation = { controller: new AbortController(), valid: true };
    const startedAt = this.now();
    this.operations.set(task.id, operation);
    this.notify();
    Promise.resolve().then(() => {
      if (!operation.valid || this.disposed) return undefined;
      return this.options.check(structuredClone(task), operation.controller.signal);
    }).then((result) => {
      if (result && operation.valid && !this.disposed) this.accept(task.id, result, Math.max(0, this.now() - startedAt));
    }).catch((error) => {
      if (operation.valid && !this.disposed) this.accept(task.id, { state: "error", summary: String(error).slice(0, 500) }, Math.max(0, this.now() - startedAt));
    }).finally(() => {
      if (this.operations.get(task.id) === operation) this.operations.delete(task.id);
      if (this.disposed) return;
      this.notify();
      this.schedule();
    });
  }

  private accept(id: string, result: CheckResult, elapsedMs = 0): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== "running") return;
    if (this.expired(task)) { this.commit({ ...task, status: "expired" }); return; }
    if (result.state === "error") { this.failed(task, result.summary, elapsedMs); return; }
    const seen = new Set(task.seenIds);
    const events = result.events.filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    });
    const advanced = result.cursor !== undefined && result.cursor !== task.cursor;
    const maxSeen = this.options.maxSeenIds ?? MAX_SEEN_IDS;
    if (seen.size > maxSeen && !advanced) { this.pause(id, "去重容量已满，请让检查命令使用增量 cursor；本批未接收"); return; }
    if (events.length && task.pending.length >= (this.options.maxPendingBatches ?? MAX_PENDING_BATCHES)) {
      this.pause(id, "待回传队列已满，请先处理结果再恢复；本批未接收"); return;
    }
    const now = this.now();
    const batch = events.length ? { id: randomUUID(), taskId: id, checkedAt: now, events: structuredClone(events) } : undefined;
    const next: MonitorRecord = {
      ...task, nextCheckAt: now + task.intervalMs, lastCheckAt: now, failures: 0, lastError: undefined,
      cursor: result.cursor ?? task.cursor, seenIds: [...seen].slice(-maxSeen),
      status: batch && task.mode === "once" ? "completed" : "running",
      pending: batch ? [...task.pending, batch] : task.pending,
      lastResult: batch ?? task.lastResult,
    };
    const accepted = batch?.events ?? [];
    // 先记检查结果再提交状态，保证 complete 与 deliver 在日志中出现在其原因之后。
    this.log(next, {
      action: "check", state: "ok", durationMs: elapsedMs, accepted: accepted.length,
      duplicates: result.events.length - accepted.length, cursorAdvanced: advanced,
      pendingBatches: next.pending.length,
      ...(accepted.length ? { events: accepted.map(({ id: eventId, summary }) => ({ id: eventId, summary })) } : {}),
    });
    if (accepted.length) this.log(next, {
      action: "check", level: "debug", cursorLength: next.cursor?.length ?? 0,
      commands: [task.command, ...task.args],
      eventData: accepted.map(({ id: eventId, data }) => ({ id: eventId, data: data === undefined ? undefined : JSON.stringify(data).slice(0, 512) })),
    });
    if (batch || advanced || task.failures || task.lastError) this.commit(next);
    else { this.tasks.set(id, next); this.notify(); }
  }

  private failed(task: MonitorRecord, summary: string, elapsedMs = 0): void {
    const failures = task.failures + 1;
    const paused = failures >= (this.options.maxFailures ?? MAX_FAILURES);
    const backoff = Math.max(task.intervalMs, Math.min(MAX_BACKOFF_MS, task.intervalMs * 2 ** Math.min(20, failures - 1)));
    this.log(task, { action: "check", state: "error", durationMs: elapsedMs, failures, error: summary });
    this.commit({
      ...task, failures, lastCheckAt: this.now(), lastError: summary,
      nextCheckAt: this.now() + backoff, status: paused ? "paused" : "running",
      pauseReason: paused ? `连续 ${failures} 次检查失败，请检查命令后恢复` : undefined,
    });
  }

  private log(task: MonitorRecord, entry: MonitorLogEntry): void {
    try { this.options.log?.(task, entry); } catch { /* 日志失败不得影响调度或状态提交。 */ }
  }
}
