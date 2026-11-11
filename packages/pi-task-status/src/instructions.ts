export const TOOL_NAME = "update_task_status";
export const TASK_STATUS_SECTION = "task_status";
export const SYSTEM_PROMPT_MARKER = "[task-status-extension]";

export const TASK_STATUS_INSTRUCTIONS = `${SYSTEM_PROMPT_MARKER}
Use ${TOOL_NAME} when first identifying a substantive task and before final delivery (status=completed, progressPercent=100).
- For tasks expected to finish within about 10 minutes, do not update again after the initial call until completion, except for the waiting/blocked transitions below.
- Enter waiting_for_user or blocked immediately when work requires user input or an external resolution; return to in_progress as soon as work resumes.
- For longer tasks, update only when status, task scope, or overall progress changes materially; ordinary phase changes such as reading, editing, testing, staging, or committing do not warrant a call.
- Use taskTransition=continue for the same deliverable, including when completed work resumes after user feedback; use taskTransition=new only after the main deliverable changes. On continue of an existing task, omit unchanged taskName and phase; provide both when creating a task.
- Estimate overall progress in 10% increments (0–90 before completion). A completed task may return to in_progress with a newly estimated progressPercent when the same deliverable needs more work.
- Keep task names concise and privacy-safe, without credentials, personal data, absolute paths, or long raw errors.`;
