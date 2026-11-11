import assert from "node:assert/strict";
import test from "node:test";
import { formatTaskStatusResult } from "../src/render.ts";

test("task status results are collapsed by default", () => {
  assert.deepEqual(
    formatTaskStatusResult("任务状态已更新：修复扩展 · 进行中（实现，估计 10%）\n当前任务已使用 1/20 次更新。", false, false, "… 展开详情"),
    ["任务状态已更新：修复扩展 · 进行中（实现，估计 10%）  … 展开详情"],
  );
});

test("expanded task status results include update usage", () => {
  assert.deepEqual(
    formatTaskStatusResult("任务状态已更新：修复扩展 · 进行中（实现，估计 10%）\n当前任务已使用 1/20 次更新。", true, false, "… 展开详情"),
    ["任务状态已更新：修复扩展 · 进行中（实现，估计 10%）", "当前任务已使用 1/20 次更新。"],
  );
});

test("task status errors stay expanded", () => {
  assert.deepEqual(
    formatTaskStatusResult("任务状态更新未接受：无效输入", false, true, "… 展开详情"),
    ["任务状态更新未接受：无效输入"],
  );
});
