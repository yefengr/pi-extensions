import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { makeDefinition } from "./config.ts";
import { DELIVERY_WINDOW_MS, MAX_ACTIVE_TASKS, NOTIFICATION_TYPE, RESULT_TYPE, STATE_TYPE, STATUS_KEY } from "./constants.ts";
import { MonitorEngine } from "./engine.ts";
import { executeCheck } from "./executor.ts";
import { MonitorLogger } from "./logging.ts";
import { buildDelivery, formatStatus, safeText, taskDetail } from "./presentation.ts";
import { historicalRecord, receiptOf, restoreRecords, type Entry } from "./state.ts";
import { persistedReceiptIds } from "./receipts.ts";
import type { DeliveryReceipt, EngineOptions, MonitorRecord, ResultBatch } from "./types.ts";

interface Binding {
  ctx: ExtensionContext;
  owner: string;
  engine: MonitorEngine;
  live: boolean;
  allowed: Set<string>;
  inFlight: Set<string>;
  confirmedBatches: Set<string>;
  statuses: Map<string, string>;
  timer?: ReturnType<typeof setTimeout>;
  receiptTimer?: ReturnType<typeof setTimeout>;
  updating?: boolean;
  dirty?: boolean;
  /** 面板持有 UI 焦点时暂停自动投递，避免插入被打断的模型轮次。 */
  panelOpen?: boolean;
}

export interface RuntimeDependencies {
  check?: EngineOptions["check"];
  deliveryWindowMs?: number;
  isDurable?: (ctx: ExtensionContext) => boolean;
  confirmedReceiptIds?: (ctx: ExtensionContext, branch: readonly Entry[]) => ReadonlySet<string>;
}

export class MonitorRuntime {
  private binding?: Binding;
  private explanationOnly = false;
  private explanationTaskIds = new Set<string>();

  private pi: ExtensionAPI;
  private deps: RuntimeDependencies;
  private logger: MonitorLogger;

  constructor(pi: ExtensionAPI, deps: RuntimeDependencies = {}) {
    this.pi = pi;
    this.deps = deps;
    this.logger = new MonitorLogger((message) => {
      const binding = this.binding;
      if (binding?.live) binding.ctx.ui.notify(safeText(message), "warning");
    });
  }

  startSession(ctx: ExtensionContext, reason: string): void {
    this.dispose();
    const binding = {
      ctx, owner: ctx.sessionManager.getSessionId(), live: true,
      allowed: new Set<string>(), inFlight: new Set<string>(), confirmedBatches: new Set<string>(), statuses: new Map<string, string>(),
    } as Binding;
    this.binding = binding;
    binding.engine = new MonitorEngine({
      check: this.deps.check ?? executeCheck,
      save: (record) => {
        this.assertCurrent(binding);
        try { this.pi.appendEntry(STATE_TYPE, { version: 1, record }); }
        catch (error) {
          // Pi 可能已更新内存树才在落盘时失败；补偿快照防止 reload 恢复未提交的游标。
          const previous = binding.engine.get(record.id);
          const rollback = previous
            ? { ...previous, status: "paused", pauseReason: "状态保存失败，请检查会话存储后恢复", resumeStatus: previous.resumeStatus ?? (previous.status === "paused" ? "running" : previous.status) }
            : { ...record, status: "stopped", pending: [], seenIds: [] };
          try { this.pi.appendEntry(STATE_TYPE, { version: 1, record: rollback }); } catch { /* 存储错误由原异常报告。 */ }
          throw error;
        }
      },
      changed: () => this.changed(binding),
      log: (task, entry) => this.logger.write(task, entry),
    });
    const branch = ctx.sessionManager.getBranch();
    const preliminary = restoreRecords(branch, binding.owner, new Set());
    const records = restoreRecords(branch, binding.owner, this.confirmedIds(ctx, branch, preliminary));
    if (reason === "reload") {
      records.forEach((task) => { binding.allowed.add(task.id); });
      if (!ctx.isIdle()) {
        const source = [...branch].reverse().find((entry) => entry.type === "custom_message" || (entry.type === "message" && entry.message.role === "user"));
        const receipt = source ? receiptOf(source) : undefined;
        this.explanationOnly = source?.type === "custom_message" && source.customType === RESULT_TYPE;
        this.explanationTaskIds = new Set(this.explanationOnly ? receipt?.deliveries.map((item) => item.taskId) ?? [] : []);
      }
    }
    const runnable = this.canRun(ctx) && this.isDurable(ctx);
    // reload 续跑全部；startup/resume 只续跑显式选择 autoResume 的任务；fork/new/tree 不续跑。
    const continueAllowed = (record: MonitorRecord) => runnable &&
      (reason === "reload" || (record.autoResume === true && (reason === "startup" || reason === "resume")));
    binding.engine.restore(records, continueAllowed);
    this.changed(binding);
  }

  dispose(): void {
    const binding = this.binding;
    this.binding = undefined;
    this.explanationOnly = false;
    this.explanationTaskIds.clear();
    if (!binding) return;
    binding.live = false;
    if (binding.timer) clearTimeout(binding.timer);
    if (binding.receiptTimer) clearTimeout(binding.receiptTimer);
    binding.engine?.dispose();
    binding.ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  beforeTree(): void {
    const binding = this.binding;
    if (!binding) return;
    this.explanationTaskIds.clear();
    binding.allowed.clear();
    if (binding.timer) clearTimeout(binding.timer);
    binding.timer = undefined;
    for (const task of binding.engine.records) {
      if (task.status === "running") binding.engine.pause(task.id, "树导航已暂停监听，请调用 resume 恢复");
    }
  }

  beforeRun(isMonitorResult: boolean, taskIds: Iterable<string> = []): void {
    this.explanationOnly = isMonitorResult;
    this.explanationTaskIds = new Set(isMonitorResult ? taskIds : []);
  }
  isExplanationOnly(): boolean { return this.explanationOnly; }
  /** 解释轮只能停止本次回执涉及的任务，避免外部结果扩大操作范围。 */
  canStopInExplanation(id: unknown): boolean {
    return this.explanationOnly && typeof id === "string" && this.explanationTaskIds.has(id);
  }
  settled(): void {
    this.explanationOnly = false;
    this.explanationTaskIds.clear();
    const binding = this.binding;
    if (!binding) return;
    this.confirmReceipts(binding);
    for (const task of binding.engine.records) {
      const unconfirmed = task.pending.filter((batch) => binding.inFlight.has(batch.id) && !binding.confirmedBatches.has(batch.id));
      if (!unconfirmed.length) continue;
      binding.allowed.delete(task.id);
      unconfirmed.forEach((batch) => { binding.inFlight.delete(batch.id); });
      this.logger.write(task, { action: "receipt-error", reason: "回执未确认，结果保留", pendingBatches: task.pending.length });
      binding.ctx.ui.notify(safeText(`监听 ${task.name} 的回传尚未确认，结果已保留；请用 /monitor resume ${task.id} 重试`), "warning");
    }
    this.changed(binding);
  }

  onReceipt(receipt: DeliveryReceipt): void {
    const binding = this.binding;
    if (!binding || receipt.ownerSessionId !== binding.owner || !this.isCurrent(binding)) return;
    receipt.deliveries.forEach((item) => { item.batchIds.forEach((id) => { binding.inFlight.add(id); }); });
    if (binding.receiptTimer) return;
    // 原生 message_end 回调完成后才落盘，不能在回调内清空 pending。
    binding.receiptTimer = setTimeout(() => {
      binding.receiptTimer = undefined;
      if (!this.isCurrent(binding)) return;
      this.confirmReceipts(binding);
      this.changed(binding);
    }, 0);
  }

  private confirmedIds(ctx: ExtensionContext, branch: readonly Entry[], records: MonitorRecord[]): ReadonlySet<string> {
    if (this.deps.confirmedReceiptIds) return this.deps.confirmedReceiptIds(ctx, branch);
    const wanted = new Set(records.flatMap((task) => task.pending.map((batch) => batch.id)));
    return persistedReceiptIds(ctx.sessionManager.getSessionFile(), branch, wanted);
  }

  private confirmReceipts(binding: Binding): void {
    if (!this.isCurrent(binding)) return;
    try {
      const branch = binding.ctx.sessionManager.getBranch();
      const confirmed = this.confirmedIds(binding.ctx, branch, binding.engine.records);
      for (const entry of branch) {
        if (!entry.id || !confirmed.has(entry.id)) continue;
        const receipt = receiptOf(entry);
        if (receipt?.ownerSessionId !== binding.owner) continue;
        for (const item of receipt.deliveries) {
          if (!binding.engine.get(item.taskId)) continue;
          item.batchIds.forEach((id) => { binding.confirmedBatches.add(id); binding.inFlight.add(id); });
          binding.engine.acknowledge(item.taskId, item.batchIds);
          const remaining = new Set(binding.engine.get(item.taskId)?.pending.map((batch) => batch.id));
          item.batchIds.forEach((id) => {
            if (remaining.has(id)) return;
            binding.inFlight.delete(id); binding.confirmedBatches.delete(id);
          });
        }
      }
    } catch (error) {
      binding.engine.records.filter((task) => task.pending.length).forEach((task) => {
        this.logger.write(task, {
          action: "receipt-error", error: String(error).slice(0, 500), pendingBatches: task.pending.length,
        });
      });
      binding.ctx.ui.notify(safeText(`监听回执核验失败，结果继续保留：${String(error)}`), "error");
    }
  }

  /** 面板打开期间暂停自动投递；关闭后按现有队列重新安排。 */
  setPanelOpen(open: boolean): void {
    const binding = this.binding;
    if (!binding || !this.isCurrent(binding) || binding.panelOpen === open) return;
    binding.panelOpen = open;
    if (open && binding.timer) {
      clearTimeout(binding.timer);
      binding.timer = undefined;
    }
    this.changed(binding);
  }

  records(ctx: ExtensionContext): MonitorRecord[] { return this.current(ctx).engine.records; }

  /** 当前分支可见的任务（含历史快照），后出现的状态覆盖先前的。 */
  private candidates(ctx: ExtensionContext, owner: string): MonitorRecord[] {
    const found = new Map<string, MonitorRecord>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
      const data = entry.data as { version?: number; record?: MonitorRecord };
      const saved = data?.record;
      if (data?.version !== 1 || saved?.ownerSessionId !== owner) continue;
      found.set(saved.id, saved);
    }
    return [...found.values()];
  }

  /** 精确 id 找不到时按唯一前缀匹配，允许直接使用卡片与面板里的 8 位短 id。 */
  private resolve(ctx: ExtensionContext, binding: Binding, id: string): MonitorRecord | undefined {
    const exact = binding.engine.get(id) ?? historicalRecord(ctx.sessionManager.getBranch(), binding.owner, id);
    if (exact) return exact;
    if (id.length < 4) return undefined;
    const matches = this.candidates(ctx, binding.owner).filter((task) => task.id.startsWith(id));
    if (matches.length > 1) throw new Error(`监听 id 前缀不唯一：${id}（${matches.length} 个匹配）`);
    return matches[0];
  }

  record(ctx: ExtensionContext, id: string): MonitorRecord {
    const binding = this.current(ctx);
    const record = this.resolve(ctx, binding, id);
    if (!record) throw new Error(`找不到当前分支的监听任务：${id}`);
    return record;
  }

  /** 批次按 id 或唯一前缀查找；已确认的批次仍可从历史快照读取。 */
  private batches(ctx: ExtensionContext, task: MonitorRecord): ResultBatch[] {
    const found = new Map<string, ResultBatch>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
      const data = entry.data as { version?: number; record?: MonitorRecord };
      const saved = data?.record;
      if (data?.version !== 1 || saved?.ownerSessionId !== task.ownerSessionId || saved.id !== task.id) continue;
      for (const item of saved.pending ?? []) found.set(item.id, item);
      if (saved.lastResult) found.set(saved.lastResult.id, saved.lastResult);
    }
    return [...found.values()];
  }

  query(ctx: ExtensionContext, id: string, batchId?: string, eventId?: string): unknown {
    const task = this.record(ctx, id);
    if (!batchId) {
      if (eventId) throw new Error("eventId 需要同时提供 batchId");
      return taskDetail(task);
    }
    const all = this.batches(ctx, task);
    let batch = all.find((item) => item.id === batchId);
    if (!batch && batchId.length >= 4) {
      const prefixed = all.filter((item) => item.id.startsWith(batchId));
      if (prefixed.length > 1) throw new Error(`批次 id 前缀不唯一：${batchId}（${prefixed.length} 个匹配）`);
      batch = prefixed[0];
    }
    if (!batch) throw new Error("当前分支找不到该结果批次");
    if (!eventId) return { taskId: id, batchId, checkedAt: batch.checkedAt, events: batch.events.map(({ id, summary }) => ({ id, summary })) };
    const event = batch.events.find((item) => item.id === eventId);
    if (!event) throw new Error("该批次找不到指定事件");
    return { taskId: id, batchId, checkedAt: batch.checkedAt, event };
  }

  async act(action: "start" | "stop" | "resume", input: unknown, ctx: ExtensionContext, signal?: AbortSignal): Promise<MonitorRecord | undefined> {
    const binding = this.current(ctx);
    if (action === "stop") {
      const id = (input as { id?: unknown })?.id;
      if (typeof id !== "string" || !id) throw new Error("必须提供监听 id");
      if (binding.engine.get(id)) binding.engine.stop(id);
      return this.record(ctx, id);
    }
    if (signal?.aborted) return;
    this.requireRunnableSession(ctx);
    if (action === "start") return this.start(input, ctx, binding);
    const id = (input as { id?: unknown })?.id;
    if (typeof id !== "string" || !id) throw new Error("必须提供监听 id");
    const record = this.record(ctx, id);
    if (record.status !== "paused" && !record.pending.length) throw new Error("只能恢复暂停的任务或待投递结果");
    this.confirmReceipts(binding);
    const fresh = binding.engine.get(id);
    if (!fresh) throw new Error("监听任务已失效");
    if (fresh.pending.some((batch) => binding.confirmedBatches.has(batch.id))) throw new Error("结果回执已落盘，但确认状态仍无法保存；请先修复会话存储，再恢复");
    if (ctx.isIdle()) fresh.pending.forEach((batch) => { binding.inFlight.delete(batch.id); });
    binding.allowed.add(id);
    if (fresh.status === "paused") binding.engine.resume(id);
    this.changed(binding);
    return binding.engine.get(id);
  }

  /** 用原定义新建一个任务；已停止/已完成的监听不能 resume，只能这样重新启动。 */
  relaunch(ctx: ExtensionContext, id: string): MonitorRecord {
    const binding = this.current(ctx);
    const source = this.record(ctx, id);
    if (source.status === "running") throw new Error("任务正在运行，无需重启");
    if (source.pending.length) throw new Error("还有待回传结果，请先恢复投递");
    this.requireRunnableSession(ctx);
    this.checkCapacity(binding);
    const duration = source.deadlineAt === undefined
      ? undefined
      : Math.max(1, Math.round((source.deadlineAt - source.createdAt) / 1_000));
    return this.start({
      action: "start", name: source.name, purpose: source.purpose, explanation: source.explanation,
      mode: source.mode, delivery: source.delivery, command: source.command, args: source.args, cwd: source.cwd,
      intervalSeconds: source.intervalMs / 1_000, timeoutSeconds: source.timeoutMs / 1_000,
      ...(duration === undefined ? {} : { maxDurationSeconds: duration }),
      logLevel: source.logLevel,
      ...(source.autoResume === true ? { autoResume: true } : {}),
    }, ctx, binding);
  }

  private start(input: unknown, ctx: ExtensionContext, binding: Binding): MonitorRecord {
    if (process.platform === "win32") throw new Error("monitor 第一版仅支持 macOS/Linux");
    this.checkCapacity(binding);
    const definition = makeDefinition(input, ctx.cwd, binding.owner);
    binding.allowed.add(definition.id);
    try {
      const record = binding.engine.add(definition);
      this.logger.write(record, {
        action: "start", mode: record.mode, delivery: record.delivery, logLevel: record.logLevel,
        intervalMs: record.intervalMs, timeoutMs: record.timeoutMs, deadlineAt: record.deadlineAt,
      });
      this.logger.write(record, { action: "start", level: "debug", commands: [record.command, ...record.args], cwd: record.cwd });
      return record;
    }
    catch (error) { binding.allowed.delete(definition.id); throw error; }
  }

  private checkCapacity(binding: Binding): void {
    const count = binding.engine.records.filter((task) => task.status === "running" || task.status === "paused" || task.pending.length).length;
    if (count >= MAX_ACTIVE_TASKS) throw new Error(`最多保留 ${MAX_ACTIVE_TASKS} 个活动或待回传任务，请先停止或处理现有任务`);
  }

  private current(ctx: ExtensionContext): Binding {
    const binding = this.binding;
    if (!binding || !this.isCurrent(binding) || ctx.sessionManager.getSessionId() !== binding.owner) throw new Error("monitor 会话尚未就绪或已切换");
    return binding;
  }
  private isCurrent(binding: Binding): boolean {
    return this.binding === binding && binding.live && binding.ctx.sessionManager.getSessionId() === binding.owner;
  }
  private assertCurrent(binding: Binding): void {
    if (!this.isCurrent(binding)) throw new Error("监听所属会话已失效");
  }
  private canRun(ctx: ExtensionContext): boolean { return ctx.mode === "tui" || ctx.mode === "rpc"; }
  private isDurable(ctx: ExtensionContext): boolean {
    if (this.deps.isDurable) return this.deps.isDurable(ctx);
    const file = ctx.sessionManager.getSessionFile();
    return !!file && existsSync(file);
  }
  private requireRunnableSession(ctx: ExtensionContext): void {
    if (!this.canRun(ctx)) throw new Error("启动或恢复监听需要 TUI 或 RPC 运行模式；print/JSON 等非交互模式不启动检查");
    if (!this.isDurable(ctx)) throw new Error("当前会话尚未落盘或使用了 --no-session；请先在持久会话发送普通消息，再注册或恢复监听");
  }

  private changed(binding: Binding): void {
    if (!this.isCurrent(binding)) return;
    if (binding.updating) { binding.dirty = true; return; }
    binding.updating = true;
    try {
      do {
        binding.dirty = false;
        this.update(binding);
      } while (binding.dirty && this.isCurrent(binding));
    } finally { binding.updating = false; }
  }

  private update(binding: Binding): void {
    const records = binding.engine.records;
    const taskIds = new Set(records.map((task) => task.id));
    for (const id of binding.allowed) if (!taskIds.has(id)) binding.allowed.delete(id);
    for (const id of binding.statuses.keys()) if (!taskIds.has(id)) binding.statuses.delete(id);
    const batchIds = new Set(records.flatMap((task) => task.pending.map((batch) => batch.id)));
    for (const id of binding.inFlight) if (!batchIds.has(id)) binding.inFlight.delete(id);
    for (const id of binding.confirmedBatches) if (!batchIds.has(id)) binding.confirmedBatches.delete(id);
    binding.ctx.ui.setStatus(STATUS_KEY, formatStatus(records));
    for (const record of records) {
      const previous = binding.statuses.get(record.id);
      binding.statuses.set(record.id, record.status);
      if (previous !== record.status && (record.status === "paused" || record.status === "expired")) {
        binding.ctx.ui.notify(safeText(`监听 ${record.name}：${record.status === "expired" ? "已到期" : record.pauseReason ?? "已暂停"}`), "warning");
      }
    }
    if (binding.panelOpen) return;
    this.deliverNotifications(binding, records);
    if (binding.timer || !records.some((task) => task.delivery === "explain" && this.deliverable(binding, task))) return;
    if (!binding.ctx.isIdle() || binding.ctx.hasPendingMessages()) return;
    const immediate = records.some((task) => task.mode === "once" && this.deliverable(binding, task));
    binding.timer = setTimeout(() => {
      binding.timer = undefined;
      this.flushExplanation(binding);
    }, immediate ? 0 : (this.deps.deliveryWindowMs ?? DELIVERY_WINDOW_MS));
  }

  private deliverable(binding: Binding, task: MonitorRecord): boolean {
    return binding.allowed.has(task.id) && task.pending.some((batch) => !binding.inFlight.has(batch.id));
  }

  private deliverNotifications(binding: Binding, records: MonitorRecord[]): void {
    for (const record of records) {
      if (record.delivery !== "notify" || !this.deliverable(binding, record)) continue;
      const deliverable = { ...record, pending: record.pending.filter((batch) => !binding.inFlight.has(batch.id)) };
      const { content, receipt } = buildDelivery([deliverable], binding.owner, "notify");
      this.pi.appendEntry(NOTIFICATION_TYPE, { content, receipt });
      receipt.deliveries.forEach((item) => { item.batchIds.forEach((id) => { binding.inFlight.add(id); }); });
      this.onReceipt(receipt);
      const selected = new Set(receipt.deliveries.flatMap((item) => item.batchIds));
      const count = record.pending.filter((batch) => selected.has(batch.id)).reduce((n, batch) => n + batch.events.length, 0);
      this.logger.write(record, { action: "deliver", delivery: "notify", batches: [...selected], events: count });
      binding.ctx.ui.notify(safeText(`监听 ${record.name} 收到 ${count} 个新事件`), "info");
    }
  }

  private flushExplanation(binding: Binding): void {
    if (!this.isCurrent(binding) || !binding.ctx.isIdle() || binding.ctx.hasPendingMessages()) return;
    const records = binding.engine.records.filter((task) => task.delivery === "explain" && this.deliverable(binding, task))
      .map((task) => ({ ...task, pending: task.pending.filter((batch) => !binding.inFlight.has(batch.id)) }));
    if (!records.length) return;
    let receipt: DeliveryReceipt | undefined;
    try {
      const delivery = buildDelivery(records, binding.owner);
      const content = delivery.content;
      receipt = delivery.receipt;
      receipt.deliveries.forEach((item) => { item.batchIds.forEach((id) => { binding.inFlight.add(id); }); });
      this.pi.sendMessage({ customType: RESULT_TYPE, content, display: true, details: receipt }, { deliverAs: "followUp", triggerTurn: true });
      receipt.deliveries.forEach((item) => {
        const task = records.find((candidate) => candidate.id === item.taskId);
        if (!task) return;
        const selected = new Set(item.batchIds);
        const count = task.pending.filter((batch) => selected.has(batch.id)).reduce((n, batch) => n + batch.events.length, 0);
        this.logger.write(task, { action: "deliver", delivery: "explain", batches: item.batchIds, events: count });
      });
    } catch (error) {
      receipt?.deliveries.forEach((item) => { item.batchIds.forEach((id) => { binding.inFlight.delete(id); }); });
      records.forEach((task) => { this.logger.write(task, { action: "deliver-error", error: String(error).slice(0, 500) }); });
      binding.ctx.ui.notify(safeText(`监听结果回传失败，将保留待回传结果：${String(error)}`), "error");
    }
  }
}

export function receiptFromMessage(message: any): DeliveryReceipt | undefined {
  return receiptOf({ type: "message", message });
}
