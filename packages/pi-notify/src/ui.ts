import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Keybinding, KeybindingsManager } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** 与 Pi 主题兼容的窄接口：面板着色只依赖实际使用的 fg/bold。 */
export type PanelTheme = Pick<Theme, "fg" | "bold">;

export type PanelFeedbackLevel = "success" | "warning" | "error";

export interface PanelFeedback {
  text: string;
  level: PanelFeedbackLevel;
}

export interface PanelView {
  title: string;
  status?: string;
  body: string[];
  mode?: string;
  feedback?: PanelFeedback | null;
  hint: string;
}

/** 共享面板外层占用的固定行数：标题、两条分隔线、快捷键提示。 */
const PANEL_FIXED_ROWS = 4;

const KEY_LABELS: Record<string, string> = {
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  pageUp: "PgUp",
  pageDown: "PgDn",
  enter: "Enter",
  escape: "Esc",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Del",
  home: "Home",
  end: "End",
};

/** 把 KeyId 转成紧凑提示标签，未识别的组合键按原样展示。 */
export function keyLabel(keyId: string): string {
  const known = KEY_LABELS[keyId];
  if (known) return known;
  return keyId
    .split("+")
    .map((part) => (part.length <= 1 ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join("+");
}

/** 从 Pi 注入的键位管理器读取实际绑定，未绑定时给出明确文案。 */
export function keyHint(keybindings: KeybindingsManager, binding: Keybinding): string {
  const keys = keybindings.getKeys(binding).map(keyLabel);
  return keys.length > 0 ? keys.join("/") : "未绑定";
}

/** 按终端可见列宽截断并补齐，保证不溢出传入宽度。 */
export function fitLine(text: string, width: number): string {
  const columns = Math.max(1, Math.floor(width));
  const truncated = truncateToWidth(text, columns, "");
  return truncated + " ".repeat(Math.max(0, columns - visibleWidth(truncated)));
}

/** 统一外壳的内容列宽：outputPad 只在真实宽度够放两侧留白时生效。 */
export function panelContentWidth(width: number, outputPad = 1): number {
  const columns = Math.max(0, Math.floor(width));
  return Math.max(0, columns - (outputPad === 0 ? 0 : columns >= 3 ? 2 : 0));
}

/** 在原生组件/自绘正文外侧包一层受限 padding，并保证整行不超过目标宽度。 */
export function padPanelLine(text: string, width: number, outputPad = 1): string {
  const columns = Math.max(0, Math.floor(width));
  if (columns === 0) return "";
  const inner = panelContentWidth(columns, outputPad);
  const pad = inner < columns ? " " : "";
  const body = fitLine(truncateToWidth(text, inner, ""), inner);
  return `${pad}${body}${pad}`;
}

export function ruleLine(theme: PanelTheme, width: number): string {
  return fitLine(theme.fg("borderMuted", "─".repeat(Math.max(1, Math.floor(width)))), width);
}

function titleLine(theme: PanelTheme, title: string, status: string, width: number): string {
  const left = theme.fg("accent", theme.bold(title));
  const room = width - visibleWidth(left) - 2;
  const statusText = status && visibleWidth(status) <= room ? status : "";
  const padding = Math.max(0, width - visibleWidth(left) - visibleWidth(statusText));
  const right = statusText ? theme.fg("dim", statusText) : "";
  return fitLine(`${left}${" ".repeat(padding)}${right}`, width);
}

/** 面板外壳占用的行数，供调用方按实际可用高度计算主体行数。 */
export function panelChromeRows(view: Pick<PanelView, "mode" | "feedback">): number {
  return PANEL_FIXED_ROWS + (view.mode ? 1 : 0) + (view.feedback ? 1 : 0);
}

/** 统一面板布局：标题、分隔线、主体、反馈、保存模式、实际键位提示。 */
export function renderPanel(theme: PanelTheme, width: number, view: PanelView, outputPad = 1): string[] {
  const columns = Math.max(0, Math.floor(width));
  if (columns === 0) return [];
  const inner = panelContentWidth(columns, outputPad);
  const lines = [
    titleLine(theme, view.title, view.status ?? "", inner),
    ruleLine(theme, inner),
    ...view.body.map((line) => fitLine(line, inner)),
    ruleLine(theme, inner),
  ];
  if (view.feedback) lines.push(fitLine(theme.fg(view.feedback.level, `  ${view.feedback.text}`), inner));
  if (view.mode) lines.push(fitLine(theme.fg("dim", `  ${view.mode}`), inner));
  lines.push(fitLine(theme.fg("dim", `  ${view.hint}`), inner));
  return lines.map((line) => padPanelLine(line, columns, outputPad));
}

/** 终端高度不足以容纳标题、主体和提示时用于提示退出，不渲染半截列表。 */
export function shortScreenNotice(theme: PanelTheme): string {
  return theme.fg("warning", "  终端高度不足，请放大窗口后重试");
}

export interface ShortPanelView {
  title: string;
  status?: string;
  notice: string;
  hint: string;
}

/**
 * 短屏最小面板：行数严格不超过预算；预算 1 时只保留退出提示，
 * 预算 2-4 时先保留标题与退出，再添加缩放提示。
 */
export function renderShortPanel(
  theme: PanelTheme,
  width: number,
  budget: number,
  view: ShortPanelView,
  outputPad = 1,
): string[] {
  const columns = Math.max(0, Math.floor(width));
  if (columns === 0 || budget <= 0) return [];
  const inner = panelContentWidth(columns, outputPad);
  const header = padPanelLine(titleLine(theme, view.title, view.status ?? "", inner), columns, outputPad);
  const notice = padPanelLine(fitLine(view.notice, inner), columns, outputPad);
  const rule = padPanelLine(ruleLine(theme, inner), columns, outputPad);
  const hint = padPanelLine(fitLine(theme.fg("dim", `  ${view.hint}`), inner), columns, outputPad);
  if (budget === 1) return [hint];
  const lines = budget >= 5 ? [header, rule, notice, rule, hint] : [header, hint, notice, rule];
  return lines.slice(0, budget);
}

/** 读取可见宽度，供提示文案按真实列宽降级。 */
export function visibleWidthSafe(text: string): number {
  return visibleWidth(text);
}

/**
 * 覆盖层有效行预算：终端高度的 80% 与 rows-2 取小，并夹到 >= 0。
 * 极短终端不能强抬到固定行数，否则会超过 compositor 的真实预算。
 */
export function overlayRowBudget(terminalRows: number): number {
  const rows = Math.max(0, Math.floor(terminalRows));
  return Math.max(0, Math.min(Math.floor(rows * 0.8), rows - 2));
}

/** 去掉原生列表末尾的空行，避免面板分隔线之间出现多余留白。 */
export function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end--;
  return lines.slice(0, end);
}
