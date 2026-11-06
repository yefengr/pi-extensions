import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSessionHandoff, parseContinueTask } from "../src/session-handoff.ts";
import { migratePersistentSession } from "../src/session.ts";

function fixture() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const dispatches: any[] = [];
  const notices: string[] = [];
  const pi = {
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    sendUserMessage: (...args: any[]) => dispatches.push(args),
  };
  const ctx = { sessionManager: { getSessionFile: () => "/sessions/source.jsonl" }, ui: { notify: (text: string) => notices.push(text) } };
  return { handoff: createSessionHandoff(pi as never), handlers, dispatches, notices, ctx, pi };
}

test("持久会话交接绑定来源和目标，settled 仅派发一次真实命令", () => {
  const f = fixture();
  assert.equal(f.handoff.schedule("/sessions/source.jsonl", "/repo", "/target"), true);
  assert.throws(f.handoff.assertAvailable, /待完成/);
  assert.throws(() => f.handoff.schedule("/sessions/source.jsonl", "/repo", "/another"), /待完成/);
  assert.deepEqual(f.handlers.get("tool_call")!({}, f.ctx), {
    block: true, terminate: true, reason: "工作空间自动切换待完成，禁止继续在旧目录执行工具；请结束本轮并等待切换。",
  });
  f.handlers.get("agent_settled")!({ aborted: false }, f.ctx);
  assert.ok(f.handlers.get("tool_call")!({}, f.ctx)?.block);
  assert.deepEqual(f.dispatches, [[
    '/worktree:migrate {"repoPath":"/repo","worktreePath":"/target","continueTask":true}',
    { expandPromptTemplates: true },
  ]]);
  f.handoff.claim(f.ctx as never, "/repo", "/target");
  f.handoff.assertAvailable();
  assert.equal(f.handlers.get("tool_call")!({}, f.ctx), undefined);
  assert.throws(() => f.handoff.claim(f.ctx as never, "/repo", "/target"), /过期/);
});

test("派发后下一次 settled 仍未消费时解除 gate、提示恢复且不重放", () => {
  const f = fixture();
  f.handoff.schedule("/sessions/source.jsonl", "/repo", "/target");
  f.handlers.get("agent_settled")!({ aborted: false }, f.ctx);
  assert.equal(f.dispatches.length, 1);
  assert.ok(f.handlers.get("tool_call")!({}, f.ctx)?.block);
  assert.equal(f.notices.length, 0);
  f.handlers.get("agent_settled")!({ aborted: false }, f.ctx);
  f.handoff.assertAvailable();
  assert.equal(f.handlers.get("tool_call")!({}, f.ctx), undefined);
  assert.throws(() => f.handoff.claim(f.ctx as never, "/repo", "/target"), /过期/);
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0], /未完成自动切换/);
  assert.ok(f.notices[0].includes('/worktree:migrate {"repoPath":"/repo","worktreePath":"/target"}'));
  f.handlers.get("agent_settled")!({ aborted: false }, f.ctx);
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.notices.length, 1);
});

test("临时会话不安排交接", () => {
  const f = fixture();
  assert.equal(f.handoff.schedule(undefined, "/repo", "/target"), false);
  f.handlers.get("agent_settled")!({ aborted: false }, f.ctx);
  assert.equal(f.dispatches.length, 0);
  f.handoff.assertAvailable();
});

for (const scenario of ["abort", "source-changed", "shutdown", "claim-mismatch", "dispatch-failure"]) {
  test(`交接 ${scenario} 后不重放、不保留旧目录工具 gate`, () => {
    const f = fixture();
    f.handoff.schedule("/sessions/source.jsonl", "/repo", "/target");
    if (scenario === "shutdown") f.handlers.get("session_shutdown")!();
    if (scenario === "source-changed") f.ctx.sessionManager.getSessionFile = () => "/sessions/another.jsonl";
    if (scenario === "dispatch-failure") f.pi.sendUserMessage = () => { throw new Error("dispatch failed"); };
    f.handlers.get("agent_settled")!({ aborted: scenario === "abort" }, f.ctx);
    if (scenario === "claim-mismatch") assert.throws(() => f.handoff.claim(f.ctx as never, "/repo", "/another"), /过期/);
    const count = f.dispatches.length;
    f.handlers.get("agent_settled")!({ aborted: false }, f.ctx);
    assert.equal(f.dispatches.length, count);
    assert.equal(f.handlers.get("tool_call")!({}, f.ctx), undefined);
    if (scenario === "shutdown") assert.throws(() => f.handoff.schedule("/sessions/source.jsonl", "/repo", "/target"), /关闭/);
    else f.handoff.assertAvailable();
    if (scenario === "dispatch-failure") assert.match(f.notices[0], /派发失败/);
    if (scenario === "abort" || scenario === "source-changed") {
      assert.equal(f.notices.length, 1);
      assert.match(f.notices[0], scenario === "abort" ? /取消/ : /来源.*变化/);
      assert.ok(f.notices[0].includes('/worktree:migrate {"repoPath":"/repo","worktreePath":"/target"}'));
      assert.doesNotMatch(f.notices[0], /已切换/);
    }
  });
}

test("通用迁移错误不声称创建工作树或仍在原会话", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "migration-errors-"));
  try {
    for (const scenario of ["cancel", "unverified", "mismatch", "exception"]) {
      const notices: string[] = [];
      const ctx = {
        cwd: "/source",
        sessionManager: { getSessionFile: () => "/sessions/source.jsonl" },
        switchSession: async (_file: string, options: any) => {
          if (scenario === "cancel") return { cancelled: true };
          if (scenario === "exception") throw new Error("switch failed");
          if (scenario === "mismatch") await options.withSession({
            cwd: path.dirname(dir), ui: { notify: (text: string) => notices.push(text) },
          });
          return { cancelled: false };
        },
      };
      await assert.rejects(() => migratePersistentSession(ctx as never, dir,
        { forkFrom: () => ({ getSessionFile: () => "/sessions/migrated.jsonl" }) }), (error: any) => {
        assert.equal(error.name, "SessionMigrationError");
        assert.equal(error.migratedSessionFile, "/sessions/migrated.jsonl");
        assert.doesNotMatch(error.message, /工作树已创建|原会话保持不变/);
        assert.match(error.message, scenario === "cancel" ? /会话切换被取消/ :
          scenario === "unverified" ? /未能验证替换会话的 cwd/ :
          scenario === "mismatch" ? /会话迁移验证失败.*cwd 不匹配/ : /会话迁移失败.*switch failed/);
        return true;
      });
      assert.equal(notices.length, scenario === "mismatch" ? 1 : 0);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("continueTask 只接受严格布尔值", () => {
  assert.equal(parseContinueTask(undefined), false);
  assert.equal(parseContinueTask(false), false);
  assert.equal(parseContinueTask(true), true);
  for (const value of [null, "true", 0, 1, {}, []]) assert.throws(() => parseContinueTask(value), /布尔值/);
});

test("自动续跑只在 replacement cwd 验证后发送 extension-authored 消息；手动迁移不触发", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "handoff-test-"));
  try {
    const target = await realpath(dir);
    for (const scenario of ["auto", "manual", "mismatch", "cancel", "resume-failure"]) {
      const calls: any[] = [];
      const ctx = {
        cwd: "/source",
        sessionManager: { getSessionFile: () => "/sessions/source.jsonl" },
        switchSession: async (_file: string, options: any) => {
          if (scenario === "cancel") return { cancelled: true };
          await options.withSession({
            cwd: scenario === "mismatch" ? path.dirname(target) : target,
            ui: { notify: (message: string) => calls.push(["notify", message]) },
            sendMessage: async (message: any, options: any) => {
              if (scenario === "resume-failure") throw new Error("resume failed");
              calls.push(["message", message, options]);
            },
          });
          return { cancelled: false };
        },
      };
      const run = () => migratePersistentSession(ctx as never, target,
        { forkFrom: () => ({ getSessionFile: () => "/sessions/migrated.jsonl" }) }, "success", scenario !== "manual");
      if (scenario === "mismatch" || scenario === "cancel") await assert.rejects(run);
      else assert.equal((await run()).status, "migrated");
      const messages = calls.filter(([kind]) => kind === "message");
      assert.equal(messages.length, scenario === "auto" ? 1 : 0);
      if (scenario === "resume-failure") {
        assert.match(calls.at(-1)[1], /会话已切换，但自动继续任务失败/);
        assert.equal(calls.filter(([kind]) => kind === "notify").length, 2);
      }
      if (messages.length) {
        assert.equal(calls[0][0], "notify");
        assert.equal(messages[0][1].customType, "worktree:message");
        assert.match(messages[0][1].content, /继续原任务.*不要重复创建/);
        assert.ok(messages[0][1].content.includes(target));
        assert.deepEqual(messages[0][2], { triggerTurn: true });
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
