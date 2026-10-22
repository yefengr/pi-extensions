import { MAX_PENDING_BATCHES, MAX_SEEN_IDS, NOTIFICATION_TYPE, RESULT_TYPE, STATE_TYPE } from "./constants.ts";
import { parseCheckResult } from "./protocol.ts";
import { retainRecords } from "./retention.ts";
import type { DeliveryReceipt, MonitorRecord } from "./types.ts";

export type Entry = { type: string; id?: string; customType?: string; data?: any; details?: any; message?: any };
const STATUSES = new Set(["running", "paused", "stopped", "completed", "expired"]);

function isRecord(value: any, owner: string): value is MonitorRecord {
  if (!value || value.ownerSessionId !== owner || typeof value.id !== "string" || !value.id) return false;
  if (!STATUSES.has(value.status) || !["once", "continuous"].includes(value.mode) || !["explain", "notify"].includes(value.delivery)) return false;
  if (value.resumeStatus !== undefined && !["running", "completed", "stopped", "expired"].includes(value.resumeStatus)) return false;
  if (!["off", "info", "debug"].includes(value.logLevel)) return false;
  if (value.autoResume !== undefined && typeof value.autoResume !== "boolean") return false;
  if (["name", "purpose", "explanation", "command", "cwd"].some((key) => typeof value[key] !== "string")) return false;
  if (!Array.isArray(value.args) || value.args.some((arg: unknown) => typeof arg !== "string")) return false;
  if (!["createdAt", "intervalMs", "timeoutMs", "nextCheckAt", "failures"].every((key) => typeof value[key] === "number" && Number.isFinite(value[key]))) return false;
  if (value.intervalMs <= 0 || value.timeoutMs <= 0 || value.failures < 0) return false;
  if (value.deadlineAt !== undefined && (typeof value.deadlineAt !== "number" || !Number.isFinite(value.deadlineAt))) return false;
  if (!Array.isArray(value.seenIds) || value.seenIds.length > MAX_SEEN_IDS || value.seenIds.some((id: unknown) => typeof id !== "string")) return false;
  if (!Array.isArray(value.pending) || value.pending.length > MAX_PENDING_BATCHES) return false;
  try {
    if (value.cursor !== undefined) parseCheckResult(JSON.stringify({ state: "ok", events: [], cursor: value.cursor }));
    for (const batch of [...value.pending, ...(value.lastResult ? [value.lastResult] : [])]) {
      if (!batch || batch.taskId !== value.id || typeof batch.id !== "string" || !Number.isFinite(batch.checkedAt)) return false;
      parseCheckResult(JSON.stringify({ state: "ok", events: batch.events }));
    }
    return true;
  } catch { return false; }
}

export function receiptOf(entry: Entry): DeliveryReceipt | undefined {
  let receipt: any;
  if (entry.type === "custom" && entry.customType === NOTIFICATION_TYPE) receipt = entry.data?.receipt;
  if (entry.type === "custom_message" && entry.customType === RESULT_TYPE) receipt = entry.details;
  if (entry.type === "message" && entry.message?.role === "custom" && entry.message.customType === RESULT_TYPE) receipt = entry.message.details;
  if (!receipt || typeof receipt.ownerSessionId !== "string" || !Array.isArray(receipt.deliveries)) return;
  if (!receipt.deliveries.every((item: any) => item && typeof item.taskId === "string" && Array.isArray(item.batchIds) && item.batchIds.every((id: unknown) => typeof id === "string"))) return;
  return receipt;
}

/** 只使用活动分支；fork/clone 继承的其他 session 记录不能启动命令。 */
export function restoreRecords(entries: readonly Entry[], owner: string, confirmedEntryIds?: ReadonlySet<string>): MonitorRecord[] {
  const records = new Map<string, MonitorRecord>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== STATE_TYPE || entry.data?.version !== 1) continue;
    const record = entry.data.record;
    if (!isRecord(record, owner)) continue;
    records.delete(record.id); records.set(record.id, record);
  }
  for (const entry of entries) {
    const receipt = receiptOf(entry);
    if (receipt?.ownerSessionId !== owner || (confirmedEntryIds && (!entry.id || !confirmedEntryIds.has(entry.id)))) continue;
    for (const item of receipt.deliveries) {
      const record = records.get(item.taskId);
      if (!record?.pending.length) continue;
      const ids = new Set(item.batchIds);
      records.set(record.id, { ...record, pending: record.pending.filter((batch) => !ids.has(batch.id)) });
    }
  }
  return structuredClone(retainRecords(records.values()));
}

export function historicalRecord(entries: readonly Entry[], owner: string, id: string): MonitorRecord | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== STATE_TYPE || entry.data?.version !== 1 || entry.data.record?.id !== id) continue;
    if (isRecord(entry.data.record, owner)) return structuredClone(entry.data.record);
  }
}
