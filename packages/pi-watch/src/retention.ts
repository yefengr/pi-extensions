import { MAX_RECENT_TASKS } from "./constants.ts";
import type { MonitorRecord } from "./types.ts";

export function isRetired(task: MonitorRecord): boolean {
  return task.status !== "running" && task.status !== "paused" && task.pending.length === 0;
}

/** 仅限制扩展缓存；原生会话历史与按 ID 查询的证据不删除。输入从旧到新。 */
export function retainRecords(records: Iterable<MonitorRecord>): MonitorRecord[] {
  const active: MonitorRecord[] = [];
  const recent: MonitorRecord[] = [];
  for (const task of records) {
    if (!isRetired(task)) { active.push(task); continue; }
    recent.push(task);
    if (recent.length > MAX_RECENT_TASKS) recent.shift();
  }
  return [...active, ...recent];
}
