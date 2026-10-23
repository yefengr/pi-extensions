export type TaskEfficiencyErrorCode =
  | "TASK_EFFICIENCY_UI_REQUIRED"
  | "TASK_EFFICIENCY_SOURCE_UNAVAILABLE"
  | "TASK_EFFICIENCY_SOURCE_STALE"
  | "TASK_EFFICIENCY_REVIEW_STATE_INVALID"
  | "TASK_EFFICIENCY_PROPOSAL_INVALID"
  | "TASK_EFFICIENCY_SCOPE_DETAIL_INVALID"
  | "TASK_EFFICIENCY_SCOPE_PAGE_INVALID"
  | "TASK_EFFICIENCY_CONFIRMATION_REQUIRED"
  | "TASK_EFFICIENCY_ANALYSIS_NOT_READY"
  | "TASK_EFFICIENCY_CANCELLED"
  | "TASK_EFFICIENCY_INTERNAL";

const MESSAGES: Readonly<Record<TaskEfficiencyErrorCode, string>> = {
  TASK_EFFICIENCY_UI_REQUIRED: "Task efficiency review requires an interactive UI.",
  TASK_EFFICIENCY_SOURCE_UNAVAILABLE: "The selected source session is unavailable.",
  TASK_EFFICIENCY_SOURCE_STALE: "The selected source session changed; restart /efficiency.",
  TASK_EFFICIENCY_REVIEW_STATE_INVALID: "The task efficiency review records are invalid.",
  TASK_EFFICIENCY_PROPOSAL_INVALID: "The proposed task range is invalid.",
  TASK_EFFICIENCY_SCOPE_DETAIL_INVALID: "The requested scope detail is invalid or too large; request a narrower range.",
  TASK_EFFICIENCY_SCOPE_PAGE_INVALID: "The requested scope page is invalid.",
  TASK_EFFICIENCY_CONFIRMATION_REQUIRED: "A matching user confirmation is required before analysis.",
  TASK_EFFICIENCY_ANALYSIS_NOT_READY: "Task efficiency analysis is not ready.",
  TASK_EFFICIENCY_CANCELLED: "Task efficiency review was cancelled.",
  TASK_EFFICIENCY_INTERNAL: "Task efficiency review could not continue.",
};

/** Error text intentionally stays stable because Pi exposes tool failures to the model. */
export class TaskEfficiencyError extends Error {
  readonly code: TaskEfficiencyErrorCode;

  constructor(code: TaskEfficiencyErrorCode) {
    super(`[${code}] ${MESSAGES[code]}`);
    this.code = code;
    this.name = "TaskEfficiencyError";
  }
}

export function fail(code: TaskEfficiencyErrorCode): never {
  throw new TaskEfficiencyError(code);
}

export function publicError(error: unknown, fallback: TaskEfficiencyErrorCode): TaskEfficiencyError {
  if (error instanceof TaskEfficiencyError) return error;
  return new TaskEfficiencyError(fallback);
}
