import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  Spacer,
  TruncatedText,
  truncateToWidth,
  type Component,
  type Focusable,
  type OverlayOptions,
} from "@earendil-works/pi-tui";

/** 源会话选择器固定可见的候选行数上限；实际行数由终端可用高度决定。 */
export const MAX_VISIBLE_SESSIONS = 10;

/** 标准面板覆盖层的高度比例，必须与 SESSION_SELECTOR_OVERLAY_OPTIONS.maxHeight 一致。 */
const OVERLAY_HEIGHT_RATIO = 0.8;
/** 标准面板覆盖层的上下外边距（margin 1）。 */
const OVERLAY_MARGIN = 1;
/** 面板固定占用的行数：上下分隔线、标题、搜索框、空行、状态、操作提示。 */
const PANEL_CHROME_ROWS = 7;
/** 预留一行，保证面板底边不紧贴覆盖层下边界。 */
const PANEL_RESERVED_ROWS = 1;
/** 显示至少一行候选所需的组件行数。 */
const MIN_PANEL_ROWS = PANEL_CHROME_ROWS + PANEL_RESERVED_ROWS + 1;

/** 源会话选择器的标准面板覆盖层配置；fullscreen 下由覆盖层接收 PgUp/PgDn。 */
export const SESSION_SELECTOR_OVERLAY_OPTIONS = Object.freeze({
  width: "80%",
  minWidth: 30,
  maxHeight: "80%",
  margin: OVERLAY_MARGIN,
} as const) satisfies OverlayOptions;

/**
 * 标准覆盖层内组件真正可用的高度预算。
 *
 * Pi 覆盖层把 maxHeight 解析为 floor(终端行数 * 80%)，再按 margin 1 收缩到
 * terminal.rows - 2；两者取小才是组件的可见行数上限。直接使用终端全高会在
 * 短屏上高估容量，导致候选行和底部提示被覆盖层裁掉。
 */
export function overlayRowBudget(terminalRows: number): number {
  if (!Number.isFinite(terminalRows)) return 0;
  const rows = Math.floor(terminalRows);
  if (rows <= 0) return 0;
  return Math.max(0, Math.min(Math.floor(rows * OVERLAY_HEIGHT_RATIO), rows - 2 * OVERLAY_MARGIN));
}

/** 至少多少终端行才能显示候选列表；更短时只显示缩放提示与退出方式。 */
export const MIN_SELECTOR_ROWS = firstTerminalRowsWithCapacity();

function firstTerminalRowsWithCapacity(): number {
  for (let rows = MIN_PANEL_ROWS; rows <= 1_000; rows += 1) {
    if (overlayRowBudget(rows) >= MIN_PANEL_ROWS) return rows;
  }
  return 1_000;
}

const KEY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  pageup: "PgUp",
  pagedown: "PgDn",
  enter: "Enter",
  return: "Enter",
  escape: "Esc",
  esc: "Esc",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Del",
  insert: "Ins",
  home: "Home",
  end: "End",
});

/**
 * 把 keybindings 返回的按键 id 格式化为提示文案。
 * 只读取注入的绑定，不在组件内假定方向键/Enter/Esc 一定可用。
 */
export function formatKeyHint(keys: readonly string[]): string {
  if (keys.length === 0) return "未绑定";
  const labels = keys.slice(0, 2).map(formatSingleKey);
  return keys.length > 2 ? `${labels.join("/")} 等` : labels.join("/");
}

function formatSingleKey(key: string): string {
  return key.split("+").map(formatKeyPart).join("+");
}

function formatKeyPart(part: string): string {
  const label = KEY_LABELS[part.toLowerCase()];
  if (label !== undefined) return label;
  const modifier = MODIFIER_LABELS[part.toLowerCase()];
  if (modifier !== undefined) return modifier;
  return part.length <= 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
}

const MODIFIER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  ctrl: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  super: "Super",
});

/** 按覆盖层预算计算候选列表可见行数；10 只是上限，不是固定页长。 */
export function sessionListCapacity(terminalRows: number): number {
  const body = overlayRowBudget(terminalRows) - PANEL_CHROME_ROWS - PANEL_RESERVED_ROWS;
  return Math.max(0, Math.min(MAX_VISIBLE_SESSIONS, body));
}

/** 选择器实际使用的主题能力；Pi 注入的 Theme 在结构上满足该接口。 */
export interface SessionSelectorTheme {
  fg(color: "accent" | "muted" | "dim" | "warning", text: string): string;
  bold(text: string): string;
}

export type SessionSelectorKeybinding =
  | "tui.select.up"
  | "tui.select.down"
  | "tui.select.pageUp"
  | "tui.select.pageDown"
  | "tui.select.confirm"
  | "tui.select.cancel";

/** 选择器实际使用的按键能力；必须传入 Pi 注入的 keybindings，而不是全局单例。 */
export interface SessionSelectorKeybindings {
  matches(data: string, keybinding: SessionSelectorKeybinding): boolean;
  getKeys(keybinding: SessionSelectorKeybinding): readonly string[];
}

export interface SearchableSessionSelectorOptions {
  readonly sessions: readonly SessionInfo[];
  readonly outputPad?: number;
  readonly theme: SessionSelectorTheme;
  readonly keybindings: SessionSelectorKeybindings;
  /** 读取终端总行数；由 Pi 注入 tui.terminal.rows，测试可替换，不回退到 process.stdout。 */
  readonly rowsProvider: () => number;
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

/** 受控面板的两种布局：常规模式显示完整面板，短终端只保留可容纳的提示与退出。 */
type ChromeMode = "full" | "compact";

/** 短终端状态下最多显示的行数：退出提示 + 缩放说明。 */
const COMPACT_MAX_LINES = 2;

/**
 * 可变单行文字：文字由 setText 更新，渲染复用原生 TruncatedText 的列宽截断。
 * TruncatedText 本身不提供 setText，因此用该薄包装持有可变内容。
 */
class MutableTruncatedText implements Component {
  private readonly paddingX: number;
  private view: TruncatedText;

  constructor(paddingX = 0) {
    this.paddingX = paddingX;
    this.view = new TruncatedText("", paddingX, 0);
  }

  setText(text: string): void {
    this.view = new TruncatedText(text, this.paddingX, 0);
  }

  invalidate(): void {
    this.view.invalidate();
  }

  render(width: number): string[] {
    return this.view.render(width);
  }
}

/**
 * 可搜索的源会话选择器。
 *
 * 候选行数由注入的 rowsProvider（真实终端行数）决定，10 仅为上限；
 * 方向键、翻页键、确认与取消都由注入的 keybindings 解析并用于底部提示，
 * 其余输入交给内部 Input 并实时筛选。选择结果直接返回 session.path，
 * 不经过标签反查。render 只同步布局缓存，不改变业务选择。
 */
export class SearchableSessionSelector extends Container implements Focusable {
  private readonly sessions: readonly SessionInfo[];
  private readonly outputPad: number;
  private readonly theme: SessionSelectorTheme;
  private readonly keybindings: SessionSelectorKeybindings;
  private readonly rowsProvider: () => number;
  private readonly onChange: () => void;
  private readonly onSelect: (path: string) => void;
  private readonly onCancel: () => void;

  private readonly topBorder: DynamicBorder;
  private readonly titleText: MutableTruncatedText;
  private readonly searchInput: Input;
  private readonly spacer: Spacer;
  private readonly listContainer: Container;
  private readonly statusText: MutableTruncatedText;
  private readonly helpText: MutableTruncatedText;
  private readonly compactExitText: MutableTruncatedText;
  private readonly compactHintText: MutableTruncatedText;
  private readonly bottomBorder: DynamicBorder;

  private query = "";
  private filtered: readonly SessionInfo[];
  private selectedIndex = 0;
  private windowStart = 0;
  private visibleRows = 0;
  private chromeMode: ChromeMode | undefined = undefined;
  private compactRows = 0;
  private _focused = false;

  constructor(options: SearchableSessionSelectorOptions) {
    super();
    this.sessions = options.sessions;
    this.outputPad = options.outputPad ?? 1;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.rowsProvider = options.rowsProvider;
    this.onChange = options.onChange;
    this.onSelect = options.onSelect;
    this.onCancel = options.onCancel;
    this.filtered = options.sessions;

    this.topBorder = new DynamicBorder((line: string) => this.theme.fg("accent", line));
    this.titleText = new MutableTruncatedText();
    this.searchInput = new Input({ prompt: "搜索: ", placeholder: "空格分隔多个关键词（AND）" });
    this.spacer = new Spacer(1);
    this.listContainer = new Container();
    this.statusText = new MutableTruncatedText();
    this.helpText = new MutableTruncatedText();
    this.compactExitText = new MutableTruncatedText();
    this.compactHintText = new MutableTruncatedText();
    this.bottomBorder = new DynamicBorder((line: string) => this.theme.fg("accent", line));

    this.buildChrome("full", 0);
    this.applyTheme();
    this.refreshStatus();
    this.syncLayout();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value && this.chromeMode === "full";
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
      this.moveSelection(-this.pageSize());
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.moveSelection(this.pageSize());
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

  override render(width: number): string[] {
    // resize 不会触发 invalidate；每次绘制前同步布局缓存，不改变选中项。
    this.syncLayout();
    if (width <= 0) return [];
    const padding = Math.min(Math.max(0, Math.floor(this.outputPad)), Math.floor((width - 1) / 2));
    const innerWidth = width - padding * 2;
    return super.render(innerWidth).map((line) =>
      truncateToWidth(" ".repeat(padding) + truncateToWidth(line, innerWidth) + " ".repeat(padding), width),
    );
  }

  override invalidate(): void {
    super.invalidate();
    this.applyTheme();
    this.refreshStatus();
    this.syncLayout();
    this.refreshList();
  }

  private pageSize(): number {
    return this.visibleRows > 0 ? this.visibleRows : MAX_VISIBLE_SESSIONS;
  }

  private moveSelection(delta: number): void {
    if (this.filtered.length === 0 || this.visibleRows === 0) return;
    const next = Math.min(this.filtered.length - 1, Math.max(0, this.selectedIndex + delta));
    if (next === this.selectedIndex) return;
    this.selectedIndex = next;
    this.ensureSelectionVisible();
    this.refreshList();
    this.refreshStatus();
    this.onChange();
  }

  private ensureSelectionVisible(): void {
    if (this.visibleRows <= 0) {
      this.windowStart = 0;
      return;
    }
    const maxStart = Math.max(0, this.filtered.length - this.visibleRows);
    if (this.selectedIndex < this.windowStart) this.windowStart = this.selectedIndex;
    if (this.selectedIndex >= this.windowStart + this.visibleRows) {
      this.windowStart = this.selectedIndex - this.visibleRows + 1;
    }
    this.windowStart = Math.min(this.windowStart, maxStart);
  }

  /** 按 rowsProvider 更新可见行数与面板形态；只调整布局/窗口缓存。 */
  private syncLayout(): void {
    const terminalRows = this.rowsProvider();
    const rows = sessionListCapacity(terminalRows);
    const mode: ChromeMode = rows > 0 ? "full" : "compact";
    const compactRows = mode === "compact" ? compactLineCount(terminalRows) : 0;
    const changed = rows !== this.visibleRows || mode !== this.chromeMode || compactRows !== this.compactRows;
    this.visibleRows = rows;
    this.buildChrome(mode, compactRows);
    if (!changed) return;
    this.ensureSelectionVisible();
    this.refreshList();
  }

  private buildChrome(mode: ChromeMode, compactRows: number): void {
    if (this.chromeMode === mode && this.compactRows === compactRows) return;
    this.clear();
    this.searchInput.focused = this._focused && mode === "full";
    if (mode === "compact") {
      this.addChild(this.compactExitText);
      if (compactRows >= 2) this.addChild(this.compactHintText);
      this.chromeMode = mode;
      this.compactRows = compactRows;
      return;
    }
    this.addChild(this.topBorder);
    this.addChild(this.titleText);
    this.addChild(this.searchInput);
    this.addChild(this.spacer);
    this.addChild(this.listContainer);
    this.addChild(this.statusText);
    this.addChild(this.helpText);
    this.addChild(this.bottomBorder);
    this.chromeMode = mode;
    this.compactRows = compactRows;
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
    // 短终端没有可见候选时禁止确认，避免选择不可见会话。
    if (this.visibleRows <= 0) return;
    const session = this.filtered[this.selectedIndex];
    if (session !== undefined) this.onSelect(session.path);
  }

  private applyTheme(): void {
    this.titleText.setText(this.theme.fg("accent", this.theme.bold("选择要复盘的源会话")));
    this.helpText.setText(this.helpLine());
    this.compactExitText.setText(this.theme.fg("dim", `${this.hint("tui.select.cancel")} 取消 · 终端过短`));
    this.compactHintText.setText(
      this.theme.fg("warning", `终端高度不足（需至少 ${MIN_SELECTOR_ROWS} 行），调整窗口后自动恢复`),
    );
  }

  private helpLine(): string {
    const cancel = this.hint("tui.select.cancel");
    if (this.visibleRows === 0) {
      return this.theme.fg("dim", `${cancel} 取消 · 终端高度不足（需至少 ${MIN_SELECTOR_ROWS} 行），调整窗口后自动恢复`);
    }
    const up = this.hint("tui.select.up");
    const down = this.hint("tui.select.down");
    const pageUp = this.hint("tui.select.pageUp");
    const pageDown = this.hint("tui.select.pageDown");
    const confirm = this.hint("tui.select.confirm");
    return this.theme.fg(
      "dim",
      `${cancel} 取消 · ${up}/${down} 移动 · ${pageUp}/${pageDown} 翻页 · ${confirm} 选择 · 输入关键词筛选（AND）`,
    );
  }

  private hint(keybinding: SessionSelectorKeybinding): string {
    return formatKeyHint(this.keybindings.getKeys(keybinding));
  }

  private refreshStatus(): void {
    const position = this.filtered.length === 0 ? 0 : this.selectedIndex + 1;
    const filtered = this.query.trim().length === 0 ? "" : ` · 筛选 ${this.filtered.length}/${this.sessions.length}`;
    this.statusText.setText(this.theme.fg("muted", `位置 ${position}/${this.filtered.length}${filtered}`));
  }

  private refreshList(): void {
    this.listContainer.clear();
    this.helpText.setText(this.helpLine());
    if (this.visibleRows === 0) return;
    if (this.filtered.length === 0) {
      this.listContainer.addChild(new TruncatedText(this.theme.fg("warning", "无匹配会话"), 0, 0));
      return;
    }
    const visible = this.filtered.slice(this.windowStart, this.windowStart + this.visibleRows);
    for (const [offset, session] of visible.entries()) {
      const index = this.windowStart + offset;
      const label = formatSessionLabel(session, index);
      const row = index === this.selectedIndex
        ? this.theme.fg("accent", this.theme.bold(`> ${label}`))
        : `  ${label}`;
      this.listContainer.addChild(new TruncatedText(row, 0, 0));
    }
  }
}

function compactLineCount(terminalRows: number): number {
  // 覆盖层预算为 0 时仍至少保留一行退出提示，其余内容不依赖裁剪。
  return Math.max(1, Math.min(COMPACT_MAX_LINES, overlayRowBudget(terminalRows)));
}

export function formatLocalTimestamp(value: string): string {
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

function truncate(value: string, maxLength: number): string {
  const characters = Array.from(value);
  return characters.length <= maxLength ? value : `${characters.slice(0, maxLength - 1).join("")}…`;
}
