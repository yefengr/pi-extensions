export const TASK_STATUS_STATE_TYPE = "task-status-state";
export const TASK_STATUS_STATE_VERSION = 1;
export const DEFAULT_MAX_UPDATES = 10;
export const MAX_STATUS_LENGTH = 120;

export const TASK_STATUSES = [
  "in_progress",
  "waiting_for_user",
  "blocked",
  "completed",
] as const;

export const TASK_TRANSITIONS = ["continue", "new"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskTransition = (typeof TASK_TRANSITIONS)[number];

export interface TaskStatusInput {
  taskTransition: TaskTransition;
  taskName: string;
  status: TaskStatus;
  phase: string;
  progressPercent: number;
}

export interface TaskStatusState {
  version: typeof TASK_STATUS_STATE_VERSION;
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

export interface TaskStatusConfig {
  maxUpdatesPerTask: number;
}
