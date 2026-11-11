import {
  MAX_STATUS_LENGTH,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  type TaskStatus,
  type TaskStatusInput,
} from "./types.ts";

const STATUS_LABELS: Record<TaskStatus, string> = {
  in_progress: "进行中",
  waiting_for_user: "等待用户",
  blocked: "已阻塞",
  completed: "已完成",
};

const TASK_MAX_LENGTH = 36;
const PHASE_MAX_LENGTH = 16;

export class StatusInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatusInputError";
  }
}

export interface NormalizedStatusInput extends TaskStatusInput {
  taskName: string;
  phase: string;
}

export function normalizeStatusInput(input: TaskStatusInput): NormalizedStatusInput {
  if (!TASK_TRANSITIONS.includes(input.taskTransition)) {
    throw new StatusInputError("taskTransition 必须是 continue 或 new");
  }
  if (!TASK_STATUSES.includes(input.status)) {
    throw new StatusInputError("status 不是受支持的会话状态");
  }

  const taskName = truncateText(cleanText(input.taskName), TASK_MAX_LENGTH);
  const phase = truncateText(cleanText(input.phase), PHASE_MAX_LENGTH);
  if (!taskName) throw new StatusInputError("taskName 不能为空");
  if (!phase) throw new StatusInputError("phase 不能为空");
  if (!Number.isInteger(input.progressPercent)) {
    throw new StatusInputError("progressPercent 必须是整数");
  }
  if (input.status === "completed") {
    if (input.progressPercent !== 100) {
      throw new StatusInputError("completed 状态的 progressPercent 必须是 100");
    }
  } else if (
    input.progressPercent < 0 ||
    input.progressPercent > 90 ||
    input.progressPercent % 10 !== 0
  ) {
    throw new StatusInputError(
      "非 completed 状态的 progressPercent 必须是 0 到 90 之间的 10% 粒度",
    );
  }

  return { ...input, taskName, phase };
}

export function formatTaskStatus(
  input: Pick<TaskStatusInput, "taskName" | "status" | "phase" | "progressPercent">,
): string {
  const taskName = truncateText(cleanText(input.taskName), TASK_MAX_LENGTH);
  const phase = truncateText(cleanText(input.phase), PHASE_MAX_LENGTH);
  const status = STATUS_LABELS[input.status];
  const suffix = ` · ${status}（${phase}，${input.progressPercent}%）`;
  const taskBudget = Math.max(1, MAX_STATUS_LENGTH - codePointLength(suffix));
  const boundedTask = truncateText(taskName, taskBudget);
  return `${boundedTask}${suffix}`;
}

export function formatFallbackStatus(): string {
  return "正在识别任务";
}

export function cleanText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncateText(value: string, maxLength: number): string {
  const chars = Array.from(value);
  return chars.length <= maxLength ? value : `${chars.slice(0, Math.max(1, maxLength - 3)).join("")}...`;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}
