import type { ExtensionCommandContext, SessionInfo } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, Text, TruncatedText, type Focusable } from "@earendil-works/pi-tui";

import type { ReviewOverhead } from "../core/index.ts";
import type { ScopeProposal } from "./records.ts";

export type ScopeAction = "confirm" | "revise" | "reselect" | "cancel";

/** 源会话选择器固定可见的候选行数，任何情况下都不得超过该值。 */
export const MAX_VISIBLE_SESSIONS = 10;

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
): Promise<string | undefined> {
  if (ctx.mode === "tui") {
    const selected = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
      return new SearchableSessionSelector({
        sessions,
        theme,
        keybindings,
        onChange: () => tui.requestRender(),
        onSelect: (path) => done(path),
        onCancel: () => done(null),
      });
    });
    return selected ?? undefined;
  }

  const options = sessions.map((session, index) => formatSessionLabel(session, index));
  const selected = await ctx.ui.select("选择要复盘的源会话", options);
  if (selected === undefined) return undefined;
  // 直接按输入顺序查找标签位置；标签含序号与短 id，重复标题也不会撞车。
  const index = options.indexOf(selected);
  return index === -1 ? undefined : sessions[index]!.path;
}

/** 选择器实际使用的主题能力；Pi 注入的 Theme 在结构上满足该接口。 */
export interface SessionSelectorTheme {
  fg(color: "accent" | "muted" | "dim" | "warning", text: string): string;
  bold(text: string): string;
}

/** 选择器实际使用的按键能力；必须传入 Pi 注入的 keybindings，而不是全局单例。 */
export interface SessionSelectorKeybindings {
  matches(
    data: string,
    keybinding:
      | "tui.select.up"
      | "tui.select.down"
      | "tui.select.pageUp"
      | "tui.select.pageDown"
      | "tui.select.confirm"
      | "tui.select.cancel",
  ): boolean;
}

export interface SearchableSessionSelectorOptions {
  readonly sessions: readonly SessionInfo[];
  readonly theme: SessionSelectorTheme;
  readonly keybindings: SessionSelectorKeybindings;
  readonly onChange: () => void;
  readonly onSelect: (path: string) => void;
  readonly onCancel: () => void;
}

/** 按 name、firstMessage 与完整 id 做大小写不敏感的多词 AND 子串筛选，保持输入顺序。 */
export function filterSessionCandidates(sessions: readonly SessionInfo[], query: string): readonly SessionInfo[] {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) return sessions;
  return sessions.filter((session) => {
    const fields = [session.name ?? "", session.firstMessage, session.id];
    return terms.every((term) => fields.some((field) => field.toLowerCase().includes(term)));
  });
}

export function formatSessionLabel(session: SessionInfo, index: number): string {
  const rawTitle = session.name?.trim() || session.firstMessage.trim() || "未命名会话";
  const title = truncate(rawTitle.replace(/\s+/g, " "), 56);
  return `${index + 1}. ${title} · ${formatLocalTimestamp(session.modified.toISOString())} · ${session.messageCount} 条消息 · ${session.id.slice(0, 8)}`;
}

/**
 * 可搜索的源会话选择器。
 *
 * 组件固定最多渲染 MAX_VISIBLE_SESSIONS 条候选；方向键与翻页键由注入的
 * keybindings 解析，其余输入交给内部 Input 并实时筛选。选择结果直接返回
 * session.path，不经过标签反查。
 */
export class SearchableSessionSelector extends Container implements Focusable {
  private readonly sessions: readonly SessionInfo[];
  private readonly theme: SessionSelectorTheme;
  private readonly keybindings: SessionSelectorKeybindings;
  private readonly onChange: () => void;
  private readonly onSelect: (path: string) => void;
  private readonly onCancel: () => void;

  private readonly titleText: Text;
  private readonly searchInput: Input;
  private readonly listContainer: Container;
  private readonly statusText: Text;
  private readonly helpText: Text;

  private query = "";
  private filtered: readonly SessionInfo[];
  private selectedIndex = 0;
  private windowStart = 0;
  private _focused = false;

  constructor(options: SearchableSessionSelectorOptions) {
    super();
    this.sessions = options.sessions;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.onChange = options.onChange;
    this.onSelect = options.onSelect;
    this.onCancel = options.onCancel;
    this.filtered = options.sessions;

    this.titleText = new Text("", 1, 0);
    this.searchInput = new Input({ prompt: "搜索: ", placeholder: "空格分隔多个关键词（AND）" });
    this.listContainer = new Container();
    this.statusText = new Text("", 1, 0);
    this.helpText = new Text("", 1, 0);

    this.addChild(new DynamicBorder((line: string) => this.theme.fg("accent", line)));
    this.addChild(this.titleText);
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.addChild(this.statusText);
    this.addChild(this.helpText);
    this.addChild(new DynamicBorder((line: string) => this.theme.fg("accent", line)));

    this.applyTheme();
    this.refreshStatus();
    this.refreshList();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.moveSelection(-MAX_VISIBLE_SESSIONS);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.moveSelection(MAX_VISIBLE_SESSIONS);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.confirmSelection();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onCancel();
      return;
    }

    this.searchInput.handleInput(data);
    const query = this.searchInput.getValue();
    if (query !== this.query) {
      this.applyQuery(query);
      return;
    }
    this.onChange();
  }

  override invalidate(): void {
    super.invalidate();
    this.applyTheme();
    this.refreshStatus();
    this.refreshList();
  }

  private moveSelection(delta: number): void {
    if (this.filtered.length === 0) return;
    const next = Math.min(this.filtered.length - 1, Math.max(0, this.selectedIndex + delta));
    if (next === this.selectedIndex) return;
    this.selectedIndex = next;
    this.ensureSelectionVisible();
    this.refreshList();
    this.refreshStatus();
    this.onChange();
  }

  private ensureSelectionVisible(): void {
    if (this.filtered.length <= MAX_VISIBLE_SESSIONS) {
      this.windowStart = 0;
      return;
    }
    if (this.selectedIndex < this.windowStart) this.windowStart = this.selectedIndex;
    if (this.selectedIndex >= this.windowStart + MAX_VISIBLE_SESSIONS) {
      this.windowStart = this.selectedIndex - MAX_VISIBLE_SESSIONS + 1;
    }
  }

  private applyQuery(query: string): void {
    this.query = query;
    this.filtered = filterSessionCandidates(this.sessions, query);
    this.selectedIndex = 0;
    this.windowStart = 0;
    this.refreshList();
    this.refreshStatus();
    this.onChange();
  }

  private confirmSelection(): void {
    const session = this.filtered[this.selectedIndex];
    if (session !== undefined) this.onSelect(session.path);
  }

  private applyTheme(): void {
    this.titleText.setText(this.theme.fg("accent", this.theme.bold("选择要复盘的源会话")));
    this.helpText.setText(this.theme.fg("dim", "↑↓ 移动 · PgUp/PgDn 翻页 · Enter 选择 · Esc 取消 · 输入关键词筛选"));
  }

  private refreshStatus(): void {
    const position = this.filtered.length === 0 ? 0 : this.selectedIndex + 1;
    const filtered = this.query.trim().length === 0 ? "" : ` · 筛选 ${this.filtered.length}/${this.sessions.length}`;
    this.statusText.setText(this.theme.fg("muted", `位置 ${position}/${this.filtered.length}${filtered}`));
  }

  private refreshList(): void {
    this.listContainer.clear();
    if (this.filtered.length === 0) {
      this.listContainer.addChild(new Text(this.theme.fg("warning", "无匹配会话"), 1, 0));
      return;
    }
    const visible = this.filtered.slice(this.windowStart, this.windowStart + MAX_VISIBLE_SESSIONS);
    for (const [offset, session] of visible.entries()) {
      const index = this.windowStart + offset;
      const label = formatSessionLabel(session, index);
      const row = index === this.selectedIndex
        ? this.theme.fg("accent", `> ${label}`)
        : `  ${label}`;
      this.listContainer.addChild(new TruncatedText(row, 1, 0));
    }
  }
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

function formatLocalTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const offsetMinutes = -date.getTimezoneOffset();
  const local = new Date(date.getTime() + offsetMinutes * 60_000).toISOString().replace("T", " ").slice(0, 19);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `${local} (UTC${sign}${hours}:${minutes})`;
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

function truncate(value: string, maxLength: number): string {
  const characters = Array.from(value);
  return characters.length <= maxLength ? value : `${characters.slice(0, maxLength - 1).join("")}…`;
}
