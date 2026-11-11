import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const TASK_EFFICIENCY_SOURCE_ENTRY_TYPE = "task-efficiency:source";

export function isTaskEfficiencyReviewSession(entries: readonly SessionEntry[]): boolean {
  return entries.some((entry) => entry.type === "custom" && entry.customType === TASK_EFFICIENCY_SOURCE_ENTRY_TYPE);
}
