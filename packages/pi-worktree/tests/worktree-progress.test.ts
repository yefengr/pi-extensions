import assert from "node:assert/strict";
import test from "node:test";
import { createWorktreeProgress, type OperationProgress } from "../src/worktree-progress.ts";

function fixture(mode = "tui", hasUI = true) {
  let shutdown: () => Promise<void> = async () => {};
  const statuses = new Map<string, string>();
  const writes: (string | undefined)[] = [];
  let invalid = false;
  let invalidAccesses = 0;
  const progress = createWorktreeProgress({ on(_event: string, listener: typeof shutdown) { shutdown = listener; } } as never);
  const ctx = { mode, hasUI, ui: { setStatus(key: string, text: string | undefined) {
    if (invalid) invalidAccesses++;
    assert.equal(invalid, false, "访问了已失效的 UI");
    writes.push(text);
    if (text === undefined) statuses.delete(key);
    else statuses.set(key, text);
  } } } as never;
  return { progress, ctx, statuses, writes, invalidAccesses: () => invalidAccesses,
    shutdown: async () => { await shutdown(); invalid = true; } };
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("立即显示、真实 elapsed 和阶段变化，成功后停止计时并清理", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let now = 100;
  t.mock.method(performance, "now", () => now);
  const f = fixture();
  await f.progress.run(f.ctx, "正在检查…", async (progress) => {
    assert.match([...f.statuses.values()][0], /正在检查…（已耗时 0 秒）/);
    now += 2_500;
    t.mock.timers.tick(1_000);
    assert.match([...f.statuses.values()][0], /已耗时 2 秒/);
    progress.update("正在移除…");
    assert.match([...f.statuses.values()][0], /正在移除…（已耗时 2 秒）/);
  });
  assert.equal(f.statuses.size, 0);
  const count = f.writes.length;
  t.mock.timers.tick(10_000);
  assert.equal(f.writes.length, count);
});

test("失败、abort、shutdown 均幂等清理，迟到更新不再访问旧上下文", async () => {
  const failed = fixture();
  const error = new Error("domain failed");
  await assert.rejects(failed.progress.run(failed.ctx, "检查", async () => { throw error; }), (value) => value === error);
  assert.equal(failed.statuses.size, 0);
  for (const shutdown of [false, true]) {
    const f = fixture();
    const controller = new AbortController();
    const gate = deferred();
    let update: OperationProgress | undefined;
    const running = f.progress.run(f.ctx, "检查", async (progress) => { update = progress; await gate.promise; }, { signal: controller.signal });
    if (shutdown) await f.shutdown();
    else controller.abort();
    const count = f.writes.length;
    update?.update("迟到");
    controller.abort();
    gate.resolve();
    await running;
    assert.equal(f.statuses.size, 0);
    assert.equal(f.writes.length, count);
    if (shutdown) await f.progress.run(f.ctx, "旧上下文", async (progress) => progress.update("忽略"));
    assert.equal(f.invalidAccesses(), 0, "不能因 sink 异常隔离而掩盖旧 UI 访问");
  }
});

test("并发操作使用独立 key，结束一个不会覆盖另一个", async () => {
  const f = fixture();
  const gates = [deferred(), deferred()];
  const first = f.progress.run(f.ctx, "甲", async () => gates[0].promise);
  const second = f.progress.run(f.ctx, "乙", async () => gates[1].promise);
  assert.equal(f.statuses.size, 2);
  gates[0].resolve();
  await first;
  assert.equal(f.statuses.size, 1);
  assert.match([...f.statuses.values()][0], /乙/);
  gates[1].resolve();
  await second;
  assert.equal(f.statuses.size, 0);
});

test("反馈 sink 抛错不影响任务及原错误；预先 abort 不发送反馈", async () => {
  const f = fixture();
  const ctx = { mode: "rpc", hasUI: true, ui: { setStatus() { throw new Error("sink"); } } } as never;
  const onUpdate = () => { throw new Error("update sink"); };
  assert.equal(await f.progress.run(ctx, "检查", async (progress) => { progress.update("移除"); return 42; }, { onUpdate }), 42);
  await assert.rejects(f.progress.run(ctx, "检查", async () => { throw new Error("actual"); }, { onUpdate }), /actual/);
  const controller = new AbortController();
  controller.abort();
  await f.progress.run(f.ctx, "检查", async (progress) => progress.update("忽略"), { signal: controller.signal });
  assert.equal(f.writes.length, 0);
});

test("模式：TUI/RPC 原生状态，print/json 不挂组件，无 UI 仍支持工具更新", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const mode of ["tui", "rpc", "print", "json"]) {
    for (const hasUI of [false, true]) {
      const f = fixture(mode, hasUI);
      const updates: string[] = [];
      await f.progress.run(f.ctx, "检查", async () => {
        t.mock.timers.tick(1_000);
        assert.equal(f.statuses.size, hasUI && (mode === "tui" || mode === "rpc") ? 1 : 0);
      }, { onUpdate: (text) => updates.push(text) });
      assert.equal(updates.length, 2);
      assert.equal(f.statuses.size, 0);
    }
  }
  const f = fixture("print", false);
  let timers = 0;
  t.mock.method(globalThis, "setInterval", () => { timers++; throw new Error("无意义 timer"); });
  await f.progress.run(f.ctx, "检查", async () => {});
  assert.equal(timers, 0);
});
