import { stripVTControlCharacters } from "node:util";

import { sliceByColumn } from "@earendil-works/pi-tui";

import { SESSION_SELECTOR_OVERLAY_OPTIONS } from "../src/extension/session-selector.ts";

/** 与 compositor 的居中、百分比宽度、minWidth 和 margin 约束一致。 */
export function selectorRectangle(columns: number): { column: number; width: number } {
  const { width: percent, minWidth, margin } = SESSION_SELECTOR_OVERLAY_OPTIONS;
  const available = Math.max(1, columns - margin * 2);
  const width = Math.max(1, Math.min(Math.max(Math.floor(columns * Number.parseFloat(percent) / 100), minWidth), available));
  return { column: margin + Math.floor((available - width) / 2), width };
}

/** 先裁出真实覆盖层列区域，再由标题相邻的 DynamicBorder 封闭纵向范围。 */
export function selectorPanelLines(screen: string, columns: number): string[] {
  const { column, width } = selectorRectangle(columns);
  const lines = screen.split("\n").map((line) => stripVTControlCharacters(sliceByColumn(line, column, width, true)));
  const title = lines.findIndex((line) => line.trim() === "选择要复盘的源会话");
  const isBorder = (line: string | undefined): boolean => line !== undefined && /^─+$/.test(line.trim());
  if (title < 1 || !isBorder(lines[title - 1])) return [];
  const bottom = lines.findIndex((line, index) => index > title && isBorder(line));
  return bottom < 0 ? [] : lines.slice(title - 1, bottom + 1);
}

export interface SmokeCandidate {
  readonly index: number;
  readonly selected: boolean;
  readonly line: string;
}

/** 仅识别封闭面板内、以 fixture 名称开头的候选，不接受背景或区域外伪候选。 */
export function selectorCandidates(screen: string, columns: number, prefixes: readonly string[]): SmokeCandidate[] {
  return selectorPanelLines(screen, columns).flatMap((line) => {
    const match = /^(>\s+)?(\d+)\.\s+(.+)$/.exec(line.trim());
    if (match === null || !prefixes.some((prefix) => match[3]!.startsWith(prefix))) return [];
    return [{ index: Number(match[2]), selected: match[1] !== undefined, line }];
  });
}
