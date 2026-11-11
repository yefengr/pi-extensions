export const TOOL_NAME = "update_task_status";
export const TASK_STATUS_SECTION = "task_status";
export const SYSTEM_PROMPT_MARKER = "[task-status-extension]";

export const TASK_STATUS_INSTRUCTIONS = `${SYSTEM_PROMPT_MARKER}
When the ${TOOL_NAME} tool is available, use it to maintain the current task status.
- Call it when first identifying a substantive task.
- For tasks expected to finish within about 10 minutes, do not update again after the initial call until completion unless the task enters or resumes from waiting_for_user or blocked.
- Enter waiting_for_user or blocked immediately when work cannot continue without user input or an external resolution; return to in_progress as soon as work resumes.
- For longer tasks, update only when the status, task scope, or overall progress changes materially.
- Reuse taskTransition=continue for the same deliverable, including when completed work resumes after user feedback; use taskTransition=new only after the main deliverable changes.
- A completed task may return to in_progress with a newly estimated progressPercent when the same deliverable needs more work.
- Do not call it for ordinary phase changes such as reading, editing, testing, staging, or committing.
- Use 10% increments only when an intermediate progress update is warranted.
- Before final delivery, call it with status=completed and progressPercent=100.
- Treat task names as concise, privacy-safe summaries without credentials, personal data, absolute paths, or long raw errors.`;

export const TASK_STATUS_PROMPT_GUIDELINES = [
  "Use update_task_status to maintain the task name, status, phase, and overall progress. Short tasks expected to finish within about 10 minutes normally update only at start and completion; enter waiting_for_user or blocked immediately when required, and return to in_progress when work resumes. When completed work resumes for the same deliverable, continue the existing task and estimate its progress again.",
];
