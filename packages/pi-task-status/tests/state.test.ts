import assert from "node:assert/strict";
import test from "node:test";
import { applyStatusUpdate, countUserMessages, findLatestState } from "../src/state.ts";

const baseInput = {
  taskTransition: "new" as const,
  taskName: "创建扩展",
  status: "in_progress" as const,
  phase: "设计",
  progressPercent: 10,
};

function options(userGeneration: number, maxUpdatesPerTask = 10) {
  return {
    maxUpdatesPerTask,
    userGeneration,
    createTaskId: () => "task-1",
  };
}

function statusEntry(state: unknown) {
  return { type: "custom", customType: "task-status-state", data: state };
}

test("initial continue creates an extension-owned task id", () => {
  const result = applyStatusUpdate(
    { ...baseInput, taskTransition: "continue" },
    undefined,
    options(1),
  );

  assert.equal(result.createdTask, true);
  assert.equal(result.state.taskId, "task-1");
  assert.equal(result.state.updatesUsed, 1);
});

test("same task continues without resetting update count", () => {
  const first = applyStatusUpdate(baseInput, undefined, options(1));
  const second = applyStatusUpdate(
    {
      ...baseInput,
      taskTransition: "continue",
      phase: "实现",
      progressPercent: 40,
    },
    first.state,
    { ...options(1), createTaskId: () => "task-2" },
  );

  assert.equal(second.state.taskId, "task-1");
  assert.equal(second.state.updatesUsed, 2);
});

test("new task requires a later user message and resets the counter", () => {
  const first = applyStatusUpdate(baseInput, undefined, options(1));
  assert.throws(
    () => applyStatusUpdate(baseInput, first.state, options(1)),
    /同一条用户消息/,
  );

  const next = applyStatusUpdate(baseInput, first.state, options(2));
  assert.equal(next.createdTask, true);
  assert.equal(next.state.taskId, "task-1");
  assert.equal(next.state.updatesUsed, 1);
});

test("completed task can resume without changing task identity", () => {
  const first = applyStatusUpdate(baseInput, undefined, options(1, 2));
  const completed = applyStatusUpdate(
    {
      taskTransition: "continue",
      taskName: "创建扩展",
      status: "completed",
      phase: "交付",
      progressPercent: 100,
    },
    first.state,
    options(1, 2),
  );
  const resumed = applyStatusUpdate(
    { ...baseInput, taskTransition: "continue", progressPercent: 30 },
    completed.state,
    { ...options(2, 2), createTaskId: () => "task-2" },
  );

  assert.equal(resumed.createdTask, false);
  assert.equal(resumed.state.taskId, "task-1");
  assert.equal(resumed.state.status, "in_progress");
  assert.equal(resumed.state.progressPercent, 30);
  assert.equal(resumed.state.updatesUsed, 3);
  assert.throws(
    () =>
      applyStatusUpdate(
        { ...baseInput, taskTransition: "continue", progressPercent: 40 },
        resumed.state,
        options(2, 2),
      ),
    /更新上限/,
  );
});

test("waiting and blocked can cross the hard limit once", () => {
  let state = applyStatusUpdate(baseInput, undefined, options(1, 2)).state;
  state = applyStatusUpdate({ ...baseInput, taskTransition: "continue", progressPercent: 20 }, state, options(1, 2)).state;
  const waiting = applyStatusUpdate(
    {
      ...baseInput,
      taskTransition: "continue",
      status: "waiting_for_user",
      phase: "等待资料",
      progressPercent: 20,
    },
    state,
    options(1, 2),
  );

  assert.equal(waiting.state.updatesUsed, 3);
  assert.throws(
    () =>
      applyStatusUpdate(
        {
          ...baseInput,
          taskTransition: "continue",
          status: "waiting_for_user",
          phase: "仍在等待",
          progressPercent: 20,
        },
        waiting.state,
        options(1, 2),
      ),
    /更新上限/,
  );
});

test("latest valid state is restored from the active branch", () => {
  const state = applyStatusUpdate(baseInput, undefined, options(1)).state;
  const entries = [
    statusEntry({ invalid: true }),
    statusEntry(state),
  ];

  assert.deepEqual(findLatestState(entries), state);
  assert.equal(countUserMessages([{ type: "message", message: { role: "user" } }]), 1);
});

test("current state entries are compared in branch order", () => {
  const first = applyStatusUpdate(baseInput, undefined, options(1)).state;
  const second = { ...first, progressPercent: 20 };

  assert.deepEqual(findLatestState([statusEntry(first), statusEntry(second)]), second);
  assert.deepEqual(findLatestState([statusEntry(second), statusEntry(first)]), first);
});

test("old customType is ignored even when its data contains valid state fields", () => {
  const state = applyStatusUpdate(baseInput, undefined, options(1)).state;
  const ignored = { type: "custom", customType: "task-title-state", data: { ...state, lastTitle: "旧标题" } };

  assert.equal(findLatestState([ignored]), undefined);
  assert.deepEqual(findLatestState([statusEntry(state), ignored]), state);
});

test("invalid newest entries are skipped in favor of earlier valid states", () => {
  const state = applyStatusUpdate(baseInput, undefined, options(1)).state;

  assert.deepEqual(
    findLatestState([
      statusEntry(state),
      statusEntry({ invalid: true }),
      { type: "custom", customType: "task-title-state", data: { version: 1 } },
    ]),
    state,
  );
});
