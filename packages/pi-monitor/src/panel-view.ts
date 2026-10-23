import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { projectLogFile } from "./logging.ts";
import { formatClock, formatDuration, formatStamp, isActiveTask, oneLineText } from "./presentation.ts";
import type { PanelKeymap } from "./panel-keymap.ts";
import type { MonitorRecord, MonitorStatus } from "./types.ts";

const STATUS_LABEL: Record<MonitorStatus, string> = {
  running: "运行", paused: "暂停", stopped: "已停止", completed: "已完成", expired: "已到期",
};

const STATUS_GLYPH: Record<MonitorStatus, { text: string; color: "success" | "warning" | "error" | "dim" }> = {
  running: { text: "●", color: "success" },
  paused: { text: "◐", color: "warning" },
  completed: { text: "✓", color: "success" },
  expired: { text: "✓", color: "dim" },
  stopped: { text: "○", color: "dim" },
};

/** 标准面板：宽度 80%、最小目标宽度 30、最大高度 80%、外边距 1。 */
export const OVERLAY_WIDTH = "80%";
export const OVERLAY_MIN_WIDTH = 30;
export const OVERLAY_MAX_HEIGHT = "80%";
export const OVERLAY_MARGIN = 1;
export const OVERLAY_HEIGHT_RATIO = 0.8;

/** 标题 + 两条分隔线 + 提示行；其余高度留给主体。 */
const CHROME_ROWS = 4;
/** 低于该可用高度时连一行主体都放不下，改为缩放提示并保留退出。 */
const MIN_PANEL_ROWS = 6;
const COMPACT_WIDTH = 68;
/** 低于该可用内容宽度时列表与提示已无法阅读，输入只保留取消。 */
const MIN_INTERACTIVE_INNER_WIDTH = 6;
const DETAIL_DATA_CHARS = 2_000;

export interface PanelRow {
  text: string;
  selected?: boolean;
  divider?: boolean;
}

export interface PanelState {
  showAll: boolean;
  selectedId?: string;
  detailId?: string;
  listTop: number;
  detailScroll: number;
  confirm?: { id: string; name: string };
  error?: string;
  notice?: string;
  busy?: boolean;
}

export interface PanelFrameInput {
  records: MonitorRecord[];
  /** 详情正文由调用方按需渲染；本模块只做纯布局，不读取运行时。 */
  detail?: { task: MonitorRecord; lines: string[] };
  /** 运行时读取失败的即时信息，渲染不得写回业务状态。 */
  failure?: string;
  width: number;
  terminalRows: number;
  outputPad: number;
  theme: Theme;
  keymap: PanelKeymap;
  state: PanelState;
}

export interface PanelFrame {
  rows: string[];
  listTop: number;
  detailScroll: number;
}

function taskNote(task: MonitorRecord): string {
  if (task.pending.length) {
    const events = task.pending.reduce((total, batch) => total + batch.events.length, 0);
    return `待回传 ${task.pending.length} 批/${events} 事件`;
  }
  if (task.status === "paused") return task.failures ? `连续失败 ${task.failures} 次` : "已暂停";
  if (task.status === "running") {
    if (task.failures) return `重试中 · 失败 ${task.failures} 次`;
    return `下次 ${formatClock(task.nextCheckAt)}`;
  }
  if (task.lastResult) return `${task.lastResult.events.length} 事件`;
  return "";
}

function pendingNote(task: MonitorRecord): string {
  if (!task.pending.length) return task.lastResult ? `批次 ${task.lastResult.id.slice(0, 8)} 已确认` : "无";
  const events = task.pending.reduce((total, batch) => total + batch.events.length, 0);
  return `${task.pending.length} 批 / ${events} 事件待回传`;
}

/** 详情正文是 Markdown 源文本；渲染交给原生 Markdown 组件。 */
export function detailDocument(task: MonitorRecord): string {
  const lines = [
    `## ${oneLineText(task.name)}`,
    "",
    `\`${task.id.slice(0, 8)}\` · ${task.mode} · ${task.delivery} · **${STATUS_LABEL[task.status]}**`,
    "",
    `- **目的**：${oneLineText(task.purpose)}`,
  ];
  if (task.explanation) lines.push(`- **解释**：${oneLineText(task.explanation)}`);
  if (task.pauseReason) lines.push(`- **原因**：${oneLineText(task.pauseReason)}`);
  lines.push(`- **命令**：\`${oneLineText([task.command, ...task.args].join(" "))}\``);
  lines.push(`- **目录**：${task.cwd}`);
  lines.push(`- **节奏**：${formatDuration(task.intervalMs)} · 超时 ${formatDuration(task.timeoutMs)}`);
  if (task.deadlineAt !== undefined) lines.push(`- **截止**：${formatStamp(task.deadlineAt)}`);
  if (task.autoResume) lines.push("- **自动恢复**：重启或切回会话时续跑");
  if (task.lastCheckAt !== undefined) lines.push(`- **上次检查**：${formatStamp(task.lastCheckAt)}`);
  if (task.failures) lines.push(`- **失败**：${task.failures} 次${task.lastError ? ` · ${oneLineText(task.lastError)}` : ""}`);
  lines.push(`- **回传**：${pendingNote(task)}`);
  lines.push(`- **日志**：\`${projectLogFile(task)}\``);

  const batch = task.pending[0] ?? task.lastResult;
  if (batch?.events.length) {
    lines.push("", `### 事件（批次 ${batch.id.slice(0, 8)} · ${formatStamp(batch.checkedAt)}）`, "");
    for (const event of batch.events) {
      lines.push(`- **${oneLineText(event.summary)}** \`${oneLineText(event.id)}\``);
      if (event.data === undefined) continue;
      const json = JSON.stringify(event.data, null, 2);
      const preview = json.length > DETAIL_DATA_CHARS ? `${json.slice(0, DETAIL_DATA_CHARS)}\n…` : json;
      lines.push("", "  ```json", ...preview.split("\n").map((line) => `  ${line}`), "  ```", "");
    }
  }
  return lines.join("\n");
}

/**
 * 当前筛选下的任务顺序；业务操作永远基于该顺序和稳定 id 定位。
 * 运行时 records 是插入顺序，showAll 时必须与渲染的「活跃在前、已结束在后」一致。
 */
export function visibleTasks(records: MonitorRecord[], showAll: boolean): MonitorRecord[] {
  const active = records.filter(isActiveTask);
  if (!showAll) return active;
  return [...active, ...records.filter((task) => !isActiveTask(task))];
}

/** 恢复提示使用与列表相同的状态标签。 */
export function statusLabel(status: MonitorStatus): string {
  return STATUS_LABEL[status];
}

/** 可见窗口起点：选中项始终在窗口内，尽量少滚动。 */
export function windowStart(index: number, capacity: number, previousTop: number): number {
  const size = Math.max(1, capacity);
  let top = Math.max(0, Math.min(previousTop, Math.max(0, index - size + 1)));
  if (index < top) top = index;
  else if (index >= top + size) top = index - size + 1;
  return Math.max(0, Math.min(top, Math.max(0, index)));
}

/** 覆盖层可用高度：终端高度 × 80% 去掉上下外边距；极短终端允许为 0。 */
export function panelAvailableRows(terminalRows: number): number {
  return Math.max(0, Math.floor(Math.max(0, terminalRows) * OVERLAY_HEIGHT_RATIO) - OVERLAY_MARGIN * 2);
}

export function panelIsTooSmall(terminalRows: number): boolean {
  return panelAvailableRows(terminalRows) < MIN_PANEL_ROWS;
}

/** 主体行数由终端高度推导，固定页长只作为上限参考。 */
export function panelBodyHeight(terminalRows: number, messageRows: number): number {
  if (panelIsTooSmall(terminalRows)) return 0;
  return Math.max(1, panelAvailableRows(terminalRows) - CHROME_ROWS - messageRows);
}

export function panelMessageRows(state: PanelState, failure?: string): number {
  return state.confirm || state.error || state.notice || state.busy || failure ? 1 : 0;
}

/** outputPad 只在真实宽度够放两侧留白时生效，极窄宽度优先保证内容列。 */
function padColumns(width: number, outputPad: number): number {
  return outputPad === 1 && width >= 3 ? 2 : 0;
}

export function innerWidth(width: number, outputPad: number): number {
  const columns = Math.max(0, Math.floor(width));
  return Math.max(0, columns - padColumns(columns, outputPad));
}

/** 极窄屏不提供可操作内容，只允许退出。 */
export function panelIsTooNarrow(width: number, outputPad: number): boolean {
  return innerWidth(width, outputPad) < MIN_INTERACTIVE_INNER_WIDTH;
}

function paintRow(row: PanelRow, width: number, theme: Theme, outputPad: number): string {
  const columns = Math.max(0, Math.floor(width));
  if (columns === 0) return "";
  const pad = padColumns(columns, outputPad) ? " " : "";
  const inner = innerWidth(columns, outputPad);
  const body = row.divider
    ? theme.fg("borderMuted", "─".repeat(inner))
    : truncateToWidth(row.text, inner, "…", true);
  return theme.bg(
    row.selected ? "selectedBg" : "toolPendingBg",
    truncateToWidth(`${pad}${body}${pad}`, columns, "…", true),
  );
}

interface DisplayEntry {
  task?: MonitorRecord;
  divider?: number;
}

/** `a` 切换全部时保留“已结束”分隔行，并把它计入主体行数。 */
function displayEntries(records: MonitorRecord[], showAll: boolean): DisplayEntry[] {
  const ordered = visibleTasks(records, showAll);
  if (!showAll) return ordered.map((task) => ({ task }));
  const activeCount = ordered.filter(isActiveTask).length;
  const finished = ordered.slice(activeCount);
  return [
    ...ordered.slice(0, activeCount).map((task) => ({ task })),
    ...(finished.length ? [{ divider: finished.length }] : []),
    ...finished.map((task) => ({ task })),
  ];
}

function titleRow(records: MonitorRecord[], state: PanelState, inner: number, theme: Theme): PanelRow {
  const left = state.detailId ? "监听详情" : "监听任务";
  const running = records.filter((task) => task.status === "running").length;
  const paused = records.filter((task) => task.status === "paused").length;
  const pending = records.filter((task) => task.pending.length > 0).length;
  const right = inner < COMPACT_WIDTH
    ? `${records.length} 个`
    : `${records.length} 个 · 运行 ${running} · 暂停 ${paused} · 待回传 ${pending}`;
  const gap = Math.max(1, inner - visibleWidth(left) - visibleWidth(right));
  return { text: `${theme.fg("accent", theme.bold(left))}${theme.fg("dim", " ".repeat(gap) + right)}` };
}

function taskRow(task: MonitorRecord, selected: boolean, compact: boolean, inner: number, theme: Theme): PanelRow {
  const glyph = STATUS_GLYPH[task.status];
  const note = taskNote(task);
  const cursor = selected ? "❯" : " ";
  const left = `${cursor} ${theme.fg(glyph.color, glyph.text)} ${theme.fg("text", oneLineText(task.name))}`;
  if (compact || !note) return { text: left, selected };
  const gap = Math.max(1, inner - visibleWidth(left) - visibleWidth(note));
  return { text: `${left}${" ".repeat(gap)}${theme.fg("dim", note)}`, selected };
}

interface RangeInfo {
  from: number;
  to: number;
  total: number;
}

function rangePrefix(range: RangeInfo | undefined): string {
  return range ? `${range.from}-${range.to}/${range.total} · ` : "";
}

/** 取消提示始终排在最前，窄屏按列截断时也不会先丢掉退出能力。 */
function hintText(keymap: PanelKeymap, state: PanelState, compact: boolean, detailRange?: RangeInfo, listRange?: RangeInfo): string {
  const cancel = keymap.hint("cancel");
  const up = keymap.hint("up");
  const down = keymap.hint("down");
  const page = `${keymap.hint("pageUp")}/${keymap.hint("pageDown")}`;
  if (state.detailId) {
    if (compact) return `${cancel} 返回 · ${rangePrefix(detailRange)}${up}/${down} · ${page} · s · r`;
    return `${cancel} 返回 · ${rangePrefix(detailRange)}${up}/${down} 行 · ${page} 翻页 · s 停止 · r 恢复/重新启动`;
  }
  const toggle = state.showAll ? "仅活跃" : "全部";
  if (compact) return `${cancel} 关闭 · ${rangePrefix(listRange)}${up}/${down} · ${keymap.hint("confirm")} · s · r · a ${toggle}`;
  return `${cancel} 关闭 · ${rangePrefix(listRange)}${up}/${down} 移动 · ${keymap.hint("confirm")} 详情 · s 停止 · r 恢复/重新启动 · a ${toggle}`;
}

function messageRow(input: PanelFrameInput, compact: boolean): PanelRow | undefined {
  const { state, failure, theme, keymap } = input;
  const cancel = keymap.hint("cancel");
  if (state.confirm) {
    const name = oneLineText(state.confirm.name);
    const text = compact
      ? `再按 s 停止 ${name}（${cancel} 取消）`
      : `再按 s 停止 ${name} · 无待回传结果时不能恢复（${cancel} 取消）`;
    return { text: theme.fg("warning", text) };
  }
  if (failure) return { text: theme.fg("error", failure) };
  if (state.error) return { text: theme.fg("error", oneLineText(state.error)) };
  if (state.notice) return { text: theme.fg("success", oneLineText(state.notice)) };
  if (state.busy) return { text: theme.fg("dim", "正在执行操作…") };
  return undefined;
}

/** 纯布局：返回渲染行和下一帧的滚动缓存，不修改传入状态。 */
export function buildPanelFrame(input: PanelFrameInput): PanelFrame {
  const { records, theme, state, width, terminalRows, outputPad, keymap } = input;
  const inner = innerWidth(width, outputPad);
  const compact = inner < COMPACT_WIDTH;
  const rows: PanelRow[] = [titleRow(records, state, inner, theme)];
  let listTop = state.listTop;
  let detailScroll = state.detailScroll;
  const budget = panelAvailableRows(terminalRows);

  // 极小尺寸：只展示退出提示，且绝不超过覆盖层有效行预算。
  if (budget <= 0) return { rows: [], listTop, detailScroll };
  const tooSmall = panelIsTooSmall(terminalRows);
  const tooNarrow = panelIsTooNarrow(width, outputPad);
  if (tooSmall || tooNarrow) {
    const reason = tooNarrow && !tooSmall ? "窗口过窄" : "窗口过小";
    // 退出键与「关闭」放最前：窄屏按列截断时先丢缩放说明，不能先丢退出能力。
    const notice: PanelRow = { text: theme.fg("warning", `${keymap.hint("cancel")} 关闭 · ${reason}，无法显示监听列表`) };
    const limited = budget >= 2 ? [rows[0], notice] : [notice];
    return { rows: limited.slice(0, budget).map((row) => paintRow(row, width, theme, outputPad)), listTop, detailScroll };
  }

  const body = panelBodyHeight(terminalRows, panelMessageRows(state, input.failure));
  rows.push({ text: "", divider: true });
  let detailRange: RangeInfo | undefined;
  let listRange: RangeInfo | undefined;

  if (input.detail) {
    const lines = input.detail.lines;
    const maxScroll = Math.max(0, lines.length - body);
    detailScroll = Math.max(0, Math.min(state.detailScroll, maxScroll));
    for (const text of lines.slice(detailScroll, detailScroll + body)) rows.push({ text });
    if (lines.length > body) {
      detailRange = { from: detailScroll + 1, to: Math.min(lines.length, detailScroll + body), total: lines.length };
    }
  } else {
    const entries = displayEntries(records, state.showAll);
    if (!entries.length) {
      rows.push({ text: theme.fg("dim", records.length ? " 当前没有活动监听，按 a 查看已结束任务" : " 当前分支没有监听任务") });
    } else {
      const selectedEntry = Math.max(0, entries.findIndex((entry) => entry.task?.id === state.selectedId));
      listTop = windowStart(selectedEntry, body, state.listTop);
      const slice = entries.slice(listTop, listTop + body);
      for (const entry of slice) {
        if (entry.divider !== undefined) {
          rows.push({ text: theme.fg("dim", `── 已结束 ${entry.divider} ──`) });
          continue;
        }
        const task = entry.task as MonitorRecord;
        rows.push(taskRow(task, task.id === state.selectedId, compact, inner, theme));
      }
      const total = entries.filter((entry) => entry.task).length;
      const before = entries.slice(0, listTop).filter((entry) => entry.task).length;
      const shown = slice.filter((entry) => entry.task).length;
      if (total > shown) listRange = { from: before + 1, to: before + shown, total };
    }
  }

  rows.push({ text: "", divider: true });
  const message = messageRow(input, compact);
  if (message) rows.push(message);
  rows.push({ text: theme.fg("dim", hintText(keymap, state, compact, detailRange, listRange)) });
  return { rows: rows.map((row) => paintRow(row, width, theme, outputPad)), listTop, detailScroll };
}
