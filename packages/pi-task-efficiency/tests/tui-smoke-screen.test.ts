import assert from "node:assert/strict";
import test from "node:test";

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { selectorCandidates, selectorPanelLines, selectorRectangle } from "../scripts/tui-smoke-screen.ts";

const PREFIXES = ["smoke 会话", "pi-lens 唯一目标会话"];

function screenFixture(columns: number): { screen: string; panel: string[] } {
  const { column, width } = selectorRectangle(columns);
  const panel = [
    "─".repeat(width),
    " 选择要复盘的源会话",
    " 搜索: ",
    " > 1. smoke 会话 中文😀",
    "   2. pi-lens 唯一目标会话",
    " 位置 1/112",
    " Esc 取消",
    "─".repeat(width),
  ].map((line) => {
    const text = truncateToWidth(line, width);
    return text + " ".repeat(width - visibleWidth(text));
  });
  const leftText = truncateToWidth("中文背景😀字", column);
  const left = leftText + " ".repeat(column - visibleWidth(leftText));
  const rows = panel.map((line) => `${left}\x1b[32m${line}\x1b[0m伪 > 98. smoke 会话`);
  return { screen: ["99. smoke 会话 背景", ...rows, "100. smoke 会话 背景"].join("\n"), panel };
}

test("矩形计算遵守百分比、最小宽度、居中与外边距", () => {
  assert.deepEqual(selectorRectangle(220), { column: 22, width: 176 });
  assert.deepEqual(selectorRectangle(60), { column: 6, width: 48 });
  assert.deepEqual(selectorRectangle(32), { column: 1, width: 30 });
  assert.deepEqual(selectorRectangle(20), { column: 1, width: 18 });
});

test("先按 Unicode 可见列裁剪，再识别封闭面板中的索引和选中项", () => {
  for (const columns of [220, 60, 32]) {
    const { screen, panel } = screenFixture(columns);
    assert.deepEqual(selectorPanelLines(screen, columns), panel);
    const candidates = selectorCandidates(screen, columns, PREFIXES);
    assert.deepEqual(candidates.map(({ index, selected }) => ({ index, selected })), [
      { index: 1, selected: true }, { index: 2, selected: false },
    ]);
    assert.ok(candidates.every(({ line }) => visibleWidth(line) <= selectorRectangle(columns).width));
  }
});

test("背景候选、区域外伪候选及缺失边框不得成为候选", () => {
  const { screen } = screenFixture(60);
  assert.deepEqual(selectorCandidates("1. smoke 会话 背景", 60, PREFIXES), []);
  const lines = screen.split("\n");
  for (const missing of [1, lines.length - 2]) {
    assert.deepEqual(selectorCandidates(lines.filter((_line, index) => index !== missing).join("\n"), 60, PREFIXES), []);
  }
  assert.deepEqual(selectorCandidates(screen.replace("选择要复盘的源会话", "另一个面板"), 60, PREFIXES), []);
});
