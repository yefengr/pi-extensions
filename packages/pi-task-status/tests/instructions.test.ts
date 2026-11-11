import assert from "node:assert/strict";
import test from "node:test";
import { SYSTEM_PROMPT_MARKER, TASK_STATUS_INSTRUCTIONS, TOOL_NAME } from "../src/instructions.ts";

test("task status tool uses the stable protocol name", () => {
  assert.equal(TOOL_NAME, "update_task_status");
  assert.equal(SYSTEM_PROMPT_MARKER, "[task-status-extension]");
  assert.doesNotMatch(TASK_STATUS_INSTRUCTIONS, /\btitle\b/i);
});

test("short tasks update only at start and completion by default", () => {
  assert.match(TASK_STATUS_INSTRUCTIONS, /when first identifying a substantive task/);
  assert.match(TASK_STATUS_INSTRUCTIONS, /within about 10 minutes/);
  assert.match(TASK_STATUS_INSTRUCTIONS, /after the initial call until completion/);
  assert.match(TASK_STATUS_INSTRUCTIONS, /before final delivery \(status=completed, progressPercent=100\)/);
});

test("waiting and blocked transitions bypass the short-task limit", () => {
  assert.match(TASK_STATUS_INSTRUCTIONS, /waiting_for_user or blocked immediately/);
  assert.match(TASK_STATUS_INSTRUCTIONS, /return to in_progress as soon as work resumes/);
});

test("completed work can resume as the same task", () => {
  assert.match(TASK_STATUS_INSTRUCTIONS, /taskTransition=continue for the same deliverable/);
  assert.match(TASK_STATUS_INSTRUCTIONS, /completed work resumes after user feedback/);
  assert.match(TASK_STATUS_INSTRUCTIONS, /taskTransition=new only after the main deliverable changes/);
  assert.match(TASK_STATUS_INSTRUCTIONS, /return to in_progress with a newly estimated progressPercent/);
});

test("unchanged names and phases can be omitted only on an existing task", () => {
  assert.match(TASK_STATUS_INSTRUCTIONS, /continue of an existing task, omit unchanged taskName and phase/);
  assert.match(TASK_STATUS_INSTRUCTIONS, /provide both when creating a task/);
});

test("ordinary phases do not trigger updates and progress remains coarse and estimated", () => {
  assert.match(TASK_STATUS_INSTRUCTIONS, /ordinary phase changes such as reading, editing, testing, staging, or committing do not warrant a call/);
  assert.match(TASK_STATUS_INSTRUCTIONS, /Estimate overall progress in 10% increments/);
  assert.match(TASK_STATUS_INSTRUCTIONS, /privacy-safe.*credentials, personal data, absolute paths, or long raw errors/);
});
