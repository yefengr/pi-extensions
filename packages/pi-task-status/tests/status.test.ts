import assert from "node:assert/strict";
import test from "node:test";
import { formatFallbackStatus, formatTaskStatus, normalizeStatusInput } from "../src/status.ts";

for (const [status, label] of [
  ["in_progress", "进行中"],
  ["waiting_for_user", "等待用户"],
  ["blocked", "已阻塞"],
] as const) {
  test(`${status} labels progress as an estimate`, () => {
    const text = formatTaskStatus({
      taskName: "创建自动任务状态扩展", status, phase: "实现", progressPercent: 40,
    });
    assert.equal(text, `创建自动任务状态扩展 · ${label}（实现，估计 40%）`);
  });
}

test("completed progress is confirmed at 100 percent", () => {
  assert.equal(formatTaskStatus({
    taskName: "交付", status: "completed", phase: "完成", progressPercent: 100,
  }), "交付 · 已完成（完成，100%）");
});

test("fallback status does not imply ongoing work", () => {
  assert.equal(formatFallbackStatus(), "尚无任务");
});

test("normalizes control characters and validates progress granularity", () => {
  const input = normalizeStatusInput({
    taskTransition: "continue", taskName: "  修复\n状态  ", status: "in_progress", phase: "实现", progressPercent: 50,
  });
  assert.equal(input.taskName, "修复 状态");
  assert.throws(() => normalizeStatusInput({ ...input, progressPercent: 55 }), /10% 粒度/);
  assert.throws(() => normalizeStatusInput({ ...input, progressPercent: 100 }), /非 completed/);
});

test("completed requires 100 percent", () => {
  assert.throws(() => normalizeStatusInput({
    taskTransition: "continue", taskName: "交付", status: "completed", phase: "验证", progressPercent: 90,
  }), /必须是 100/);
});

test("long task stays bounded without project or branch metadata", () => {
  const text = formatTaskStatus({
    taskName: "这是一个很长的任务名称，用于验证状态限制和字段截断行为，并确保不会重新带入项目或分支信息",
    status: "in_progress", phase: "验证和回归测试", progressPercent: 60,
  });
  assert.ok(Array.from(text).length <= 120);
  assert.doesNotMatch(text, /agent-tools|feat\//);
  assert.match(text, /进行中（验证和回归测试，估计 60%）$/);
});
