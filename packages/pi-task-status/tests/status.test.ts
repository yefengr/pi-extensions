import assert from "node:assert/strict";
import test from "node:test";
import { formatFallbackStatus, formatTaskStatus, normalizeStatusInput } from "../src/status.ts";

test("formatTaskStatus includes only task status phase and progress", () => {
  const text = formatTaskStatus({
    taskName: "创建自动任务状态扩展",
    status: "in_progress",
    phase: "实现",
    progressPercent: 40,
  });

  assert.equal(text, "创建自动任务状态扩展 · 进行中（实现，40%）");
});

test("fallback status contains no project context", () => {
  assert.equal(formatFallbackStatus(), "正在识别任务");
});

test("normalizes control characters and validates progress granularity", () => {
  const input = normalizeStatusInput({
    taskTransition: "continue",
    taskName: "  修复\n状态  ",
    status: "in_progress",
    phase: "实现",
    progressPercent: 50,
  });

  assert.equal(input.taskName, "修复 状态");
  assert.throws(
    () =>
      normalizeStatusInput({
        ...input,
        progressPercent: 55,
      }),
    /10% 粒度/,
  );
});

test("completed requires 100 percent", () => {
  assert.throws(
    () =>
      normalizeStatusInput({
        taskTransition: "continue",
        taskName: "交付",
        status: "completed",
        phase: "验证",
        progressPercent: 90,
      }),
    /必须是 100/,
  );
});

test("long task stays bounded without project or branch metadata", () => {
  const text = formatTaskStatus({
    taskName: "这是一个很长的任务名称，用于验证状态限制和字段截断行为，并确保不会重新带入项目或分支信息",
    status: "in_progress",
    phase: "验证和回归测试",
    progressPercent: 60,
  });

  assert.ok(Array.from(text).length <= 120);
  assert.doesNotMatch(text, /agent-tools|feat\//);
  assert.match(text, /进行中（验证和回归测试，60%）$/);
});
