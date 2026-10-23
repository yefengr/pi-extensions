import assert from "node:assert/strict";
import test from "node:test";
import { MonitorEngine } from "../src/engine.ts";
import { MAX_RECENT_TASKS } from "../src/constants.ts";
import type { CheckResult, EngineOptions, MonitorRecord } from "../src/types.ts";
import { definition, eventually } from "./helpers.ts";

const event = (id: string) => ({ id, summary: `事件 ${id}` });
const ok = (ids: string[] = [], cursor?: string): CheckResult => ({ state: "ok", events: ids.map(event), ...(cursor === undefined ? {} : { cursor }) });
function engine(options: Partial<EngineOptions> = {}) {
  const saved: MonitorRecord[] = [];
  const instance = new MonitorEngine({ check: async () => ok(), save: (record) => saved.push(structuredClone(record)), changed() {}, ...options });
  return { instance, saved };
}

test("once saves complete first batch and keeps outbox after stopping", async (t) => {
  let checks = 0;
  const { instance: e, saved } = engine({ check: async () => { checks++; return ok(["a", "b"]); } });
  t.after(() => e.dispose());
  e.add(definition({ mode: "once", intervalMs: 1 }));
  await eventually(() => e.get("task-1")?.status === "completed");
  assert.equal(e.get("task-1")?.pending[0].events.length, 2);
  assert.equal(checks, 1);
  assert.equal(saved.at(-1)?.pending.length, 1);
  e.stop("task-1");
  assert.equal(e.get("task-1")?.pending.length, 1);
  e.acknowledge("task-1", [e.get("task-1")!.pending[0].id]);
  assert.equal(e.get("task-1")?.pending.length, 0);
});

test("empty polls stay in RAM; continuous new IDs only, duplicate does not enqueue", async (t) => {
  let count = 0;
  const { instance: e, saved } = engine({ check: async () => { count++; return count <= 2 ? ok() : ok(["a"]); } });
  t.after(() => e.dispose());
  e.add(definition({ intervalMs: 8 }));
  await eventually(() => count >= 5);
  e.pause("task-1", "test");
  assert.equal(e.get("task-1")?.pending.length, 1);
  assert.equal(saved.length, 3); // 注册、事件、暂停；空轮询与重复事件不追加。
  assert.equal(e.get("task-1")?.status, "paused");
});

test("checker errors and throws retry with backoff then pause, not complete", async (t) => {
  let calls = 0;
  const { instance: e } = engine({ maxFailures: 2, check: async () => { calls++; if (calls === 1) throw new Error("network"); return { state: "error", summary: "offline" }; } });
  t.after(() => e.dispose());
  e.add(definition({ mode: "once", intervalMs: 5 }));
  await eventually(() => e.get("task-1")?.status === "paused");
  assert.equal(e.get("task-1")?.failures, 2);
  assert.equal(e.get("task-1")?.pending.length, 0);
  assert.equal(calls, 2);
});

test("recovering from error resets failure state", async (t) => {
  let calls = 0;
  const { instance: e } = engine({ check: async () => ++calls === 1 ? { state: "error", summary: "offline" } : ok() });
  t.after(() => e.dispose());
  e.add(definition({ intervalMs: 5 }));
  await eventually(() => calls >= 2 && e.get("task-1")?.failures === 0);
  assert.equal(e.get("task-1")?.lastError, undefined);
});

test("deadline during check cancels and discards late results", async (t) => {
  let finish: (result: CheckResult) => void = () => {};
  let aborted = false;
  const { instance: e } = engine({ check: async (_task, signal) => {
    signal.addEventListener("abort", () => { aborted = true; });
    return new Promise((resolve) => { finish = resolve; });
  } });
  t.after(() => e.dispose());
  e.add(definition({ deadlineAt: Date.now() + 50 }));
  await eventually(() => e.get("task-1")?.status === "expired");
  assert.equal(aborted, true);
  finish(ok(["late"]));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(e.get("task-1")?.pending.length, 0);
});

test("pause/resume cannot overlap an old cancellation still draining", async (t) => {
  let calls = 0;
  let finish: (result: CheckResult) => void = () => {};
  const { instance: e } = engine({ check: async () => {
    calls++;
    if (calls === 1) return new Promise((resolve) => { finish = resolve; });
    return ok();
  } });
  t.after(() => e.dispose());
  e.add(definition());
  await eventually(() => calls === 1);
  e.pause("task-1", "manual"); e.resume("task-1");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  finish(ok(["cancelled"]));
  await eventually(() => calls === 2);
  assert.equal(e.get("task-1")?.pending.length, 0);
});

test("shared concurrency never exceeds limit and next due tasks get slots", async (t) => {
  const finishes: Array<(result: CheckResult) => void> = [];
  let active = 0;
  let peak = 0;
  const { instance: e } = engine({ maxConcurrent: 2, check: async () => {
    active++; peak = Math.max(peak, active);
    return new Promise<CheckResult>((resolve) => finishes.push((result) => { active--; resolve(result); }));
  } });
  t.after(() => e.dispose());
  for (let n = 0; n < 3; n++) e.add(definition({ id: `task-${n}` }));
  await eventually(() => finishes.length === 2);
  finishes[0](ok());
  await eventually(() => finishes.length === 3);
  assert.equal(peak, 2);
  finishes[1](ok()); finishes[2](ok());
});

test("cursor and outbox commit together; capacities pause without consuming results", async (t) => {
  let calls = 0;
  const { instance: e } = engine({ maxSeenIds: 1, check: async () => ok([`${++calls}`]) });
  t.after(() => e.dispose());
  e.add(definition({ intervalMs: 5 }));
  await eventually(() => e.get("task-1")?.status === "paused");
  assert.deepEqual(e.get("task-1")?.seenIds, ["1"]);
  assert.equal(e.get("task-1")?.pending.length, 1);
  let count = 0;
  const { instance: c } = engine({ maxSeenIds: 1, maxPendingBatches: 2, check: async () => { count++; return ok([`${count}`], `cursor-${count}`); } });
  t.after(() => c.dispose());
  c.add(definition({ intervalMs: 5 }));
  await eventually(() => c.get("task-1")?.status === "paused");
  assert.equal(c.get("task-1")?.cursor, "cursor-2");
  assert.deepEqual(c.get("task-1")?.seenIds, ["2"]);
  assert.equal(c.get("task-1")?.pending.length, 2);
});

test("persist failure does not advance cursor or lose outbox, cannot spin at deadline", async (t) => {
  let writes = 0;
  const { instance: e } = engine({ save: () => { if (++writes > 1) throw new Error("disk full"); }, check: async () => ok(["a"], "next") });
  t.after(() => e.dispose());
  e.add(definition({ deadlineAt: Date.now() + 30 }));
  await eventually(() => e.get("task-1")?.status === "paused");
  assert.equal(e.get("task-1")?.cursor, undefined);
  assert.deepEqual(e.get("task-1")?.seenIds, []);
  assert.deepEqual(e.get("task-1")?.pending, []);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(writes, 2);
});

test("restore reload resumes, normal startup pauses and absolute deadline is retained", async (t) => {
  const { instance: first } = engine();
  first.add(definition());
  const snapshot = first.records;
  first.dispose();
  let calls = 0;
  const { instance: reload } = engine({ check: async () => { calls++; return ok(); } });
  t.after(() => reload.dispose());
  reload.restore(snapshot, () => true);
  await eventually(() => calls === 1);
  const { instance: startup } = engine();
  t.after(() => startup.dispose());
  startup.restore(snapshot, () => false);
  assert.equal(startup.get("task-1")?.status, "paused");
  const { instance: expired } = engine();
  t.after(() => expired.dispose());
  expired.restore([{ ...snapshot[0], deadlineAt: Date.now() - 1 }], () => true);
  assert.equal(expired.get("task-1")?.status, "expired");
});

test("restore keeps only records allowed by the auto-resume predicate running", (t) => {
  const { instance: first } = engine();
  first.add(definition({ id: "keep" }));
  first.add(definition({ id: "pause" }));
  const snapshot = first.records;
  first.dispose();
  const { instance: restored } = engine();
  t.after(() => restored.dispose());
  restored.restore(snapshot, (record) => record.id === "keep");
  assert.equal(restored.get("keep")?.status, "running");
  assert.equal(restored.get("pause")?.status, "paused");
  assert.match(restored.get("pause")?.pauseReason ?? "", /重新进入会话/);
});

test("terminal task cache is bounded while active tasks remain retained", (t) => {
  const { instance: e } = engine(); t.after(() => e.dispose());
  e.add(definition({ id: "active" }));
  for (let n = 0; n < MAX_RECENT_TASKS + 8; n++) {
    const id = `retired-${n}`;
    e.add(definition({ id })); e.stop(id);
  }
  assert.equal(e.records.length, MAX_RECENT_TASKS + 1);
  assert.equal(e.get("active")?.status, "running");
  assert.equal(e.get("retired-0"), undefined);
  assert.equal(e.get(`retired-${MAX_RECENT_TASKS + 7}`)?.status, "stopped");
});

test("dispose ignores late results and state snapshots cannot mutate internals", async () => {
  let finish: (result: CheckResult) => void = () => {};
  const { instance: e, saved } = engine({ check: async () => new Promise((resolve) => { finish = resolve; }) });
  e.add(definition());
  await eventually(() => e.checkingIds.size === 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const snapshot = e.records;
  snapshot[0].seenIds.push("external");
  assert.deepEqual(e.get("task-1")?.seenIds, []);
  e.dispose(); e.dispose(); finish(ok(["late"]));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(saved.length, 1);
  assert.throws(() => e.resume("task-1"), /释放/);
});
