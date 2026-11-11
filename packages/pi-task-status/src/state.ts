import {
  TASK_STATUSES,
  TASK_STATUS_STATE_TYPE,
  TASK_STATUS_STATE_VERSION,
  type TaskStatus,
  type TaskStatusInput,
  type TaskStatusState,
} from "./types.ts";
import { normalizeStatusInput } from "./status.ts";

export interface SessionEntryLike {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
  message?: unknown;
}

export interface ApplyStatusUpdateOptions {
  maxUpdatesPerTask: number;
  userGeneration: number;
  createTaskId: () => string;
}

export interface ApplyStatusUpdateResult {
  state: TaskStatusState;
  changed: boolean;
  createdTask: boolean;
}

export class StateUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateUpdateError";
  }
}

export function findLatestState(
  entries: readonly SessionEntryLike[],
): TaskStatusState | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom") continue;
    if (entry.customType === TASK_STATUS_STATE_TYPE) {
      const state = parseState(entry.data);
      if (state) return state;
      continue;
    }
  }
  return undefined;
}

export function countUserMessages(entries: readonly SessionEntryLike[]): number {
  return entries.filter(
    (entry) =>
      entry.type === "message" &&
      Boolean(entry.message) &&
      typeof entry.message === "object" &&
      (entry.message as { role?: unknown }).role === "user",
  ).length;
}

export function applyStatusUpdate(
  input: TaskStatusInput,
  current: TaskStatusState | undefined,
  options: ApplyStatusUpdateOptions,
): ApplyStatusUpdateResult {
  const normalized = normalizeStatusInput(input);
  const startsNewTask = !current || normalized.taskTransition === "new";
  if (
    current &&
    startsNewTask &&
    options.userGeneration <= current.lastTransitionGeneration
  ) {
    throw new StateUpdateError("同一条用户消息中不能切换多个 task；请继续使用 taskTransition=continue");
  }

  const taskId = startsNewTask ? options.createTaskId() : current!.taskId;
  const baseState = startsNewTask
    ? {
        version: TASK_STATUS_STATE_VERSION as 1,
        taskId,
        taskName: normalized.taskName,
        status: normalized.status,
        phase: normalized.phase,
        progressPercent: normalized.progressPercent,
        updatesUsed: 0,
        lastTransitionGeneration: options.userGeneration,
        waitingEscapeUsed: false,
        blockedEscapeUsed: false,
      }
    : current!;

  const modelChanged =
    startsNewTask ||
    baseState.taskName !== normalized.taskName ||
    baseState.status !== normalized.status ||
    baseState.phase !== normalized.phase ||
    baseState.progressPercent !== normalized.progressPercent;
  if (!modelChanged) {
    return { state: current!, changed: false, createdTask: false };
  }

  const enteringWaiting =
    normalized.status === "waiting_for_user" && baseState.status !== normalized.status;
  const enteringBlocked = normalized.status === "blocked" && baseState.status !== normalized.status;
  const resumingCompleted =
    baseState.status === "completed" && normalized.status !== "completed";
  const waitingEscapeUsed = baseState.waitingEscapeUsed || enteringWaiting;
  const blockedEscapeUsed = baseState.blockedEscapeUsed || enteringBlocked;
  const criticalEscapeAvailable =
    (enteringWaiting && !baseState.waitingEscapeUsed) ||
    (enteringBlocked && !baseState.blockedEscapeUsed) ||
    resumingCompleted ||
    normalized.status === "completed";

  if (!startsNewTask && baseState.updatesUsed >= options.maxUpdatesPerTask && !criticalEscapeAvailable) {
    throw new StateUpdateError(
      `当前任务已达到 ${options.maxUpdatesPerTask} 次更新上限，请等待新任务或仅在状态切换为 waiting_for_user、blocked、completed，或恢复已完成任务时更新`,
    );
  }

  return {
    state: {
      ...baseState,
      taskName: normalized.taskName,
      status: normalized.status,
      phase: normalized.phase,
      progressPercent: normalized.progressPercent,
      updatesUsed: startsNewTask ? 1 : baseState.updatesUsed + 1,
      waitingEscapeUsed,
      blockedEscapeUsed,
    },
    changed: true,
    createdTask: startsNewTask,
  };
}

function parseState(value: unknown): TaskStatusState | undefined {
  const fields = parseStateFields(value);
  if (!fields) return undefined;
  return { version: TASK_STATUS_STATE_VERSION, ...fields };
}

interface ParsedStateFields {
  taskId: string;
  taskName: string;
  status: TaskStatus;
  phase: string;
  progressPercent: number;
  updatesUsed: number;
  lastTransitionGeneration: number;
  waitingEscapeUsed: boolean;
  blockedEscapeUsed: boolean;
}

function parseStateFields(value: unknown): ParsedStateFields | undefined {
  if (!value || typeof value !== "object") return undefined;
  const {
    version,
    taskId,
    taskName,
    phase,
    status,
    progressPercent,
    updatesUsed,
    lastTransitionGeneration,
    waitingEscapeUsed,
    blockedEscapeUsed,
  } = value as Partial<TaskStatusState>;
  if (
    version !== TASK_STATUS_STATE_VERSION ||
    typeof taskId !== "string" ||
    !taskId ||
    typeof taskName !== "string" ||
    typeof phase !== "string" ||
    !isTaskStatus(status) ||
    typeof progressPercent !== "number" ||
    !Number.isInteger(progressPercent) ||
    typeof updatesUsed !== "number" ||
    !Number.isInteger(updatesUsed) ||
    updatesUsed < 0 ||
    typeof lastTransitionGeneration !== "number" ||
    !Number.isInteger(lastTransitionGeneration) ||
    lastTransitionGeneration < 0 ||
    typeof waitingEscapeUsed !== "boolean" ||
    typeof blockedEscapeUsed !== "boolean"
  ) {
    return undefined;
  }
  try {
    const normalized = normalizeStatusInput({
      taskTransition: "continue",
      taskName,
      status,
      phase,
      progressPercent,
    });
    return {
      taskId,
      taskName: normalized.taskName,
      status,
      phase: normalized.phase,
      progressPercent,
      updatesUsed,
      lastTransitionGeneration,
      waitingEscapeUsed,
      blockedEscapeUsed,
    };
  } catch {
    return undefined;
  }
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && TASK_STATUSES.includes(value as TaskStatus);
}
