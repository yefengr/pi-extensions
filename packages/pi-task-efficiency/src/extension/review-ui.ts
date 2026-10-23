import type { ExtensionCommandContext, SessionInfo } from "@earendil-works/pi-coding-agent";

import type { ReviewOverhead } from "../core/index.ts";
import type { ScopeProposal } from "./records.ts";
import {
  formatLocalTimestamp,
  formatSessionLabel,
  SearchableSessionSelector,
  SESSION_SELECTOR_OVERLAY_OPTIONS,
} from "./session-selector.ts";

export {
  filterSessionCandidates,
  formatKeyHint,
  formatSessionLabel,
  MAX_VISIBLE_SESSIONS,
  MIN_SELECTOR_ROWS,
  overlayRowBudget,
  SearchableSessionSelector,
  SESSION_SELECTOR_OVERLAY_OPTIONS,
  type SearchableSessionSelectorOptions,
  type SessionSelectorKeybinding,
  type SessionSelectorKeybindings,
  type SessionSelectorTheme,
  sessionListCapacity,
} from "./session-selector.ts";

export type ScopeAction = "confirm" | "revise" | "reselect" | "cancel";

const ACTION_LABELS: Readonly<Record<ScopeAction, string>> = Object.freeze({
  confirm: "确认范围",
  revise: "修正范围",
  reselect: "重新选择会话",
  cancel: "取消复盘",
});

export function scopeActionOptions(): readonly string[] {
  return Object.values(ACTION_LABELS);
}

export function parseScopeAction(value: string | undefined): ScopeAction {
  if (value === undefined) return "cancel";
  const localized = (Object.entries(ACTION_LABELS) as [ScopeAction, string][])
    .find(([, label]) => label === value)?.[0];
  return localized ?? "cancel";
}

export async function selectSourceSession(
  ctx: ExtensionCommandContext,
  sessions: readonly SessionInfo[],
  outputPad = 1,
): Promise<string | undefined> {
  if (ctx.mode === "tui") {
    // 使用标准覆盖层：fullscreen 模式下主界面会先消费内嵌自定义组件的 PgUp/PgDn，
    // 只有覆盖层能可靠收到翻页键。尺寸预算与 sessionListCapacity 共用 80%/margin 1。
    const selected = await ctx.ui.custom<string | null>(
      (tui, theme, keybindings, done) => {
        return new SearchableSessionSelector({
          sessions,
          outputPad,
          theme,
          keybindings,
          rowsProvider: () => tui.terminal.rows,
          onChange: () => tui.requestRender(),
          onSelect: (path) => done(path),
          onCancel: () => done(null),
        });
      },
      { overlay: true, overlayOptions: SESSION_SELECTOR_OVERLAY_OPTIONS },
    );
    return selected ?? undefined;
  }

  const options = sessions.map((session, index) => formatSessionLabel(session, index));
  const selected = await ctx.ui.select("选择要复盘的源会话", options);
  if (selected === undefined) return undefined;
  // 直接按输入顺序查找标签位置；标签含序号与短 id，重复标题也不会撞车。
  const index = options.indexOf(selected);
  return index === -1 ? undefined : sessions[index]!.path;
}

export function scopeSummary(proposal: ScopeProposal, turnCount: number): string {
  const duration = Math.max(0, Date.parse(proposal.endTimestamp) - Date.parse(proposal.startTimestamp)) / 1_000;
  return [
    "确认任务范围",
    `任务：${proposal.summary}`,
    `范围：${formatLocalTimestamp(proposal.startTimestamp)} 至 ${formatLocalTimestamp(proposal.endTimestamp)}`,
    `跨度：${formatDuration(duration)}，${turnCount} 个用户回合`,
    `包含：${proposal.included.join("；")}`,
    `排除：${proposal.excluded.join("；") || "无"}`,
    `依据：${proposal.rationale}`,
    `置信度：${formatConfidence(proposal.confidence)}`,
  ].join("\n");
}

export function formatReviewOverhead(overhead: ReviewOverhead): string {
  return [
    "复盘自身开销（不计入源任务）",
    `耗时：${formatNullableDuration(overhead.wallClockSpanSeconds)}；模型响应：${overhead.modelResponses}；工具调用：${overhead.toolCalls}`,
    `Kickoff：${formatBytes(overhead.kickoffBytes)}；复盘会话：${formatBytes(overhead.sessionBytes)}`,
    `Tokens：${formatNullableNumber(overhead.tokens.totalTokens)}（cache read ${formatNullableNumber(overhead.tokens.cacheRead)}）`,
    `Pi 会话记录费用：${formatNullableCost(overhead.cost.total)}`,
    `覆盖：必需指标${overhead.coverage.requiredMetricsComplete ? "完整" : "不完整"}；reasoning ${overhead.coverage.reasoningComplete ? "完整" : "不可核实"}`,
  ].join("\n");
}

function formatConfidence(confidence: ScopeProposal["confidence"]): string {
  return confidence === "high" ? "高" : confidence === "medium" ? "中" : "低";
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${minutes} 分 ${remainder.toFixed(1)} 秒`;
}

function formatNullableDuration(seconds: number | null): string {
  return seconds === null ? "不可核实" : formatDuration(seconds);
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  return `${(bytes / 1_024).toFixed(1)} KiB`;
}

function formatNullableNumber(value: number | null): string {
  return value === null ? "不可核实" : value.toLocaleString("en-US");
}

function formatNullableCost(value: number | null): string {
  return value === null ? "不可核实" : `$${value.toFixed(6)}`;
}
