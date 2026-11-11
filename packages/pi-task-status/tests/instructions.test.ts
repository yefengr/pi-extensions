import assert from "node:assert/strict";
import test from "node:test";
import {
  SYSTEM_PROMPT_MARKER,
  TASK_STATUS_INSTRUCTIONS,
  TASK_STATUS_PROMPT_GUIDELINES,
  TOOL_NAME,
} from "../src/instructions.ts";

test("task status tool uses the new protocol name", () => {
  assert.equal(TOOL_NAME, "update_task_status");
  assert.equal(SYSTEM_PROMPT_MARKER, "[task-status-extension]");
  assert.doesNotMatch(TASK_STATUS_INSTRUCTIONS, /\btitle\b/i);
});

test("task status instructions update only at start and completion by default", () => {
  assert.match(TASK_STATUS_INSTRUCTIONS, /within about 10 minutes/);
  assert.match(TASK_STATUS_INSTRUCTIONS, /after the initial call until completion/);
  assert.match(TASK_STATUS_PROMPT_GUIDELINES.join("\n"), /only at start and completion/);
});

test("waiting and blocked transitions bypass the short-task limit", () => {
  assert.match(TASK_STATUS_INSTRUCTIONS, /waiting_for_user or blocked immediately/);
  assert.match(TASK_STATUS_INSTRUCTIONS, /return to in_progress as soon as work resumes/);
  assert.match(TASK_STATUS_PROMPT_GUIDELINES.join("\n"), /return to in_progress when work resumes/);
});

test("completed work can resume as the same task", () => {
  assert.match(TASK_STATUS_INSTRUCTIONS, /completed work resumes after user feedback/);
  assert.match(TASK_STATUS_INSTRUCTIONS, /return to in_progress with a newly estimated progressPercent/);
  assert.match(TASK_STATUS_PROMPT_GUIDELINES.join("\n"), /continue the existing task/);
});

test("ordinary phases do not trigger status updates", () => {
  assert.match(
    TASK_STATUS_INSTRUCTIONS,
    /ordinary phase changes such as reading, editing, testing, staging, or committing/,
  );
});
