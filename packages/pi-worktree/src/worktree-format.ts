import type { RemoveWorktreeResult, WorktreeRecord } from "./worktree-types.ts";

export function formatLocalTime(value: string | undefined, missing = "无法读取"): string {
  if (!value) return missing;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return missing;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value;
  return `${part("year")}/${part("month")}/${part("day")} ${part("hour")}:${part("minute")}:${part("second")} ${part("timeZoneName")}`;
}

export function formatWorktreeRecord(record: WorktreeRecord): string {
  const state = record.detached ? "detached HEAD" : (record.branch ?? "未知分支");
  const flags = [record.locked ? "locked" : "", record.prunable ? "prunable" : ""].filter(Boolean);
  return `${record.path} | ${state} | 创建：${formatLocalTime(record.createdAt, "未知")} | 最近提交：${formatLocalTime(record.lastCommitAt)}${flags.length ? ` | ${flags.join(", ")}` : ""}`;
}

export function formatWorktreeList(repoPath: string, records: WorktreeRecord[]): string {
  return [`仓库：${repoPath}`, ...records.map((record) => `- ${formatWorktreeRecord(record)}`)].join("\n");
}

export function formatRemoveResult(result: RemoveWorktreeResult): string {
  const branchResult = result.branchStatus === "deleted"
    ? `已删除 ${result.branch}`
    : result.branchStatus === "preserved"
      ? `已保留 ${result.branch}`
      : "无（detached HEAD）";
  return [
    `工作树已移除：${result.worktreePath}`,
    `仓库：${result.repoPath}`,
    `创建：${formatLocalTime(result.createdAt)}`,
    `最近提交：${formatLocalTime(result.lastCommitAt)}`,
    `关联分支：${branchResult}`,
  ].join("\n");
}
