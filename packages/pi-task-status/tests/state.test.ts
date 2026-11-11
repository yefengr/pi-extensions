import assert from "node:assert/strict";
import test from "node:test";
import { applyStatusUpdate, countUserMessages, findLatestState } from "../src/state.ts";
import { DEFAULT_MAX_UPDATES, type TaskStatus, type TaskStatusUpdateInput } from "../src/types.ts";

const baseInput = {
  taskTransition: "new" as const,
  taskName: "创建扩展",
  status: "in_progress" as const,
  phase: "设计",
  progressPercent: 10,
};

function options(userGeneration: number, maxUpdatesPerTask = DEFAULT_MAX_UPDATES) {
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

test("continue inherits only omitted name and phase, preserving task identity", () => {
  const initial = applyStatusUpdate(baseInput, undefined, options(1)).state;
  const renamed = applyStatusUpdate({
    taskTransition: "continue", taskName: "修正名称", status: "in_progress", progressPercent: 20,
  }, initial, options(1)).state;
  assert.equal(renamed.taskName, "修正名称");
  assert.equal(renamed.phase, "设计");
  const rephased = applyStatusUpdate({
    taskTransition: "continue", phase: "实现", status: "in_progress", progressPercent: 40,
  }, renamed, options(1)).state;
  assert.equal(rephased.taskName, "修正名称");
  assert.equal(rephased.phase, "实现");
  assert.equal(rephased.taskId, initial.taskId);
  assert.equal(rephased.updatesUsed, 3);
});

for (const taskTransition of ["new", "continue"] as const) {
  test(`initial ${taskTransition} requires both name and phase`, () => {
    for (const fields of [{}, { taskName: "新任务" }, { phase: "分析" }]) {
      assert.throws(() => applyStatusUpdate({
        taskTransition, status: "in_progress", progressPercent: 0, ...fields,
      }, undefined, options(1)), /taskName|phase/);
    }
  });
}

test("new never inherits missing fields from an existing task", () => {
  const current = applyStatusUpdate(baseInput, undefined, options(1)).state;
  for (const fields of [{}, { taskName: "新任务" }, { phase: "分析" }]) {
    assert.throws(() => applyStatusUpdate({
      taskTransition: "new", status: "in_progress", progressPercent: 0, ...fields,
    }, current, options(2)), /taskName|phase/);
  }
  assert.equal(current.updatesUsed, 1);
  assert.equal(current.taskName, baseInput.taskName);
});

test("continue rejects explicit blank, null and non-string fields without inheriting", () => {
  const current = applyStatusUpdate(baseInput, undefined, options(1)).state;
  for (const field of ["taskName", "phase"] as const) {
    for (const value of ["", " \n\t", null, 123, false, {}]) {
      const input = {
        taskTransition: "continue", status: "in_progress", progressPercent: 20, [field]: value,
      } as unknown as TaskStatusUpdateInput;
      assert.throws(() => applyStatusUpdate(input, current, options(1)), new RegExp(field));
    }
  }
  assert.equal(current.updatesUsed, 1);
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
  const first = applyStatusUpdate(baseInput, undefined, options(1, 1));
  assert.throws(
    () => applyStatusUpdate(baseInput, first.state, options(1, 1)),
    /同一条用户消息/,
  );

  const next = applyStatusUpdate(baseInput, first.state, { ...options(2, 1), createTaskId: () => "task-2" });
  assert.equal(next.createdTask, true);
  assert.equal(next.state.taskId, "task-2");
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

test("waiting entry may exceed the limit while same-status edits remain limited", () => {
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

for (const limit of [1, 2]) {
  test(`超限后反复等待、阻塞、恢复与完成保留任务和 v1 记录（上限 ${limit}）`, () => {
    const opts = options(1, limit);
    let state = applyStatusUpdate(baseInput, undefined, opts).state;
    if (limit === 2) {
      state = applyStatusUpdate({ ...baseInput, taskTransition: "continue", progressPercent: 20 }, state, opts).state;
    }
    const statuses: TaskStatus[] = [
      "waiting_for_user", "in_progress", "blocked", "in_progress",
      "waiting_for_user", "blocked", "completed", "in_progress", "blocked", "completed",
    ];
    for (const [index, status] of statuses.entries()) {
      const result = applyStatusUpdate({
        taskTransition: "continue", status,
        progressPercent: status === "completed" ? 100 : 20,
      }, state, opts);
      assert.equal(result.changed, true);
      assert.equal(result.createdTask, false);
      assert.equal(result.state.taskId, "task-1");
      assert.equal(result.state.status, status);
      assert.equal(result.state.updatesUsed, limit + index + 1);
      const restored = findLatestState([statusEntry(JSON.parse(JSON.stringify(result.state)))]);
      assert.deepEqual(restored, result.state);
      state = restored!;
    }
    assert.equal(state.version, 1);
    assert.equal(state.waitingEscapeUsed, true);
    assert.equal(state.blockedEscapeUsed, true);
  });
}

for (const status of ["in_progress", "waiting_for_user", "blocked", "completed"] as const) {
  test(`超限后 ${status} 的同状态修改被拒绝，原样重试不计数`, () => {
    const input = { ...baseInput, taskTransition: "continue" as const, status, progressPercent: status === "completed" ? 100 : 10 };
    const opts = options(1, 1);
    const state = applyStatusUpdate(input, undefined, opts).state;
    const unchanged = applyStatusUpdate({
      taskTransition: "continue", status, progressPercent: input.progressPercent,
    }, state, opts);
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.state, state);
    assert.equal(unchanged.state.updatesUsed, 1);
    for (const change of [{ taskName: "改名" }, { phase: "改阶段" }, ...(status === "completed" ? [] : [{ progressPercent: 20 }])]) {
      assert.throws(() => applyStatusUpdate({ ...input, ...change }, state, opts), /普通更新上限/);
    }
  });
}

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
