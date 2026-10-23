import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth, visibleWidth, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { formatClock, formatDuration, formatStamp, isActiveTask, oneLineText } from "./presentation.ts";
import { projectLogFile } from "./logging.ts";
import type { MonitorRuntime } from "./runtime.ts";
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

/** 列表一次显示的任务数，其余折叠成一行提示；详情窗口按行滚动。 */
const LIST_LIMIT = 14;
const DETAIL_ROWS = 18;
const DETAIL_DATA_CHARS = 2_000;

interface Row {
  text: string;
  selected?: boolean;
  divider?: boolean;
}

interface PanelInit {
  runtime: MonitorRuntime;
  ctx: ExtensionCommandContext;
  tui: TUI;
  theme: Theme;
  done: () => void;
  initialId?: string;
  showAll?: boolean;
  /** Pi 的 outputPad 设置：1 时左右各留一列。 */
  outputPad?: number;
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

function detailDocument(task: MonitorRecord): string {
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

class MonitorPanel implements Focusable {
  focused = false;

  private readonly init: PanelInit;
  private index = 0;
  private showAll: boolean;
  private detailId?: string;
  private scroll = 0;
  private confirm?: { id: string; name: string };
  private error?: string;
  private notice?: string;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(init: PanelInit) {
    this.init = init;
    this.showAll = init.showAll === true;
    if (init.initialId) {
      const matches = this.records().filter((task) => task.id === init.initialId || task.id.startsWith(init.initialId!));
      if (matches.length === 1) this.detailId = matches[0].id;
      else if (matches.length > 1) this.error = `id 前缀不唯一：${init.initialId}`;
      else this.error = `找不到监听任务：${init.initialId.slice(0, 8)}`;
    }
    // 引擎在面板打开期间继续检查，定时重绘即可看到最新状态。
    this.timer = setInterval(() => init.tui.requestRender(), 1_000);
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  handleInput(data: string): void {
    this.notice = undefined;
    if (matchesKey(data, Key.escape)) {
      if (this.confirm) { this.confirm = undefined; this.refresh(); return; }
      if (this.detailId) { this.detailId = undefined; this.scroll = 0; this.refresh(); return; }
      this.init.done();
      return;
    }
    if (this.detailId) this.handleDetail(data);
    else this.handleList(data);
  }

  private handleList(data: string): void {
    const records = this.shown();
    if (data === "a") {
      this.showAll = !this.showAll;
      this.index = 0;
      this.confirm = undefined;
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.index = Math.max(0, Math.min(this.index, records.length - 1) - 1);
      this.confirm = undefined;
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.index = Math.max(0, Math.min(this.index + 1, records.length - 1));
      this.confirm = undefined;
      this.refresh();
      return;
    }
    const task = records[this.index];
    if (!task) return;
    if (matchesKey(data, Key.return) || matchesKey(data, Key.enter)) {
      this.detailId = task.id;
      this.scroll = 0;
      this.refresh();
      return;
    }
    if (data === "s") this.requestStop(task);
    if (data === "r") this.resumeOrRestart(task);
  }

  private handleDetail(data: string): void {
    const task = this.records().find((item) => item.id === this.detailId);
    if (!task) { this.detailId = undefined; this.refresh(); return; }
    if (matchesKey(data, Key.pageUp)) { this.scroll = Math.max(0, this.scroll - DETAIL_ROWS); this.refresh(); return; }
    if (matchesKey(data, Key.pageDown)) { this.scroll += DETAIL_ROWS; this.refresh(); return; }
    if (data === "s") this.requestStop(task);
    if (data === "r") this.resumeOrRestart(task);
  }

  /** 停止不可随时回退：没有待回传结果时的停止不可恢复，因此需要二次确认。 */
  private requestStop(task: MonitorRecord): void {
    if (this.confirm?.id !== task.id) {
      this.confirm = { id: task.id, name: task.name };
      this.error = undefined;
      this.refresh();
      return;
    }
    this.run("stop", task);
  }

  /** 暂停或待投递走恢复；已停止/已完成/已到期按原定义重新启动（新 id）；运行中只提示。 */
  private resumeOrRestart(task: MonitorRecord): void {
    if (task.status === "running") {
      this.notice = undefined;
      this.error = `${task.name} 正在运行，无需恢复`;
      this.refresh();
      return;
    }
    if (task.status === "paused" || task.pending.length) {
      this.run("resume", task);
      return;
    }
    this.relaunch(task);
  }

  private relaunch(task: MonitorRecord): void {
    this.confirm = undefined;
    try {
      const created = this.init.runtime.relaunch(this.init.ctx, task.id);
      this.error = undefined;
      this.notice = `已重新启动 ${task.name} → ${created.id.slice(0, 8)}（原任务保留为${STATUS_LABEL[task.status]}）`;
    } catch (error) {
      this.notice = undefined;
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.refresh();
  }

  private run(action: "stop" | "resume", task: MonitorRecord): void {
    this.confirm = undefined;
    void this.init.runtime.act(action, { id: task.id }, this.init.ctx)
      .then(() => {
        this.error = undefined;
        this.notice = action === "stop" ? `已停止 ${task.name}` : `已恢复 ${task.name}`;
        this.refresh();
      })
      .catch((error) => {
        this.notice = undefined;
        this.error = error instanceof Error ? error.message : String(error);
        this.refresh();
      });
  }

  private refresh(): void {
    this.init.tui.requestRender();
  }

  /** 列表默认只显示活跃任务；`a` 切换后才包含已结束任务。 */
  private shown(): MonitorRecord[] {
    const all = this.records();
    return this.showAll ? all : all.filter(isActiveTask);
  }

  private records(): MonitorRecord[] {
    try {
      return this.init.runtime.records(this.init.ctx);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return [];
    }
  }

  private innerWidth(width: number): number {
    return Math.max(12, width - (this.init.outputPad === 1 ? 2 : 0));
  }

  private compact(width: number): boolean {
    return this.innerWidth(width) < 68;
  }

  private paint(row: Row, width: number): string {
    const theme = this.init.theme;
    const pad = this.init.outputPad === 1 ? " " : "";
    const inner = this.innerWidth(width);
    const body = row.divider
      ? theme.fg("borderMuted", "─".repeat(inner))
      : truncateToWidth(row.text, inner, "", true);
    return theme.bg(row.selected ? "selectedBg" : "toolPendingBg", `${pad}${body}${pad}`);
  }

  private titleRow(width: number): Row {
    const records = this.shown();
    const theme = this.init.theme;
    const left = this.detailId ? "监听详情" : "监听任务";
    const running = records.filter((task) => task.status === "running").length;
    const paused = records.filter((task) => task.status === "paused").length;
    const pending = records.filter((task) => task.pending.length > 0).length;
    const right = this.compact(width)
      ? `${records.length} 个`
      : `${records.length} 个 · 运行 ${running} · 暂停 ${paused} · 待回传 ${pending}`;
    const gap = Math.max(1, this.innerWidth(width) - visibleWidth(left) - visibleWidth(right));
    return { text: `${theme.fg("accent", theme.bold(left))}${theme.fg("dim", " ".repeat(gap) + right)}` };
  }

  private listRows(width: number): Row[] {
    const all = this.records();
    const active = all.filter(isActiveTask);
    const finished = all.filter((task) => !isActiveTask(task));
    const records = this.shown();
    const theme = this.init.theme;
    if (!records.length) {
      return [{ text: theme.fg("dim", finished.length ? " 当前没有活动监听，按 a 查看已结束任务" : " 当前分支没有监听任务") }];
    }
    this.index = Math.max(0, Math.min(this.index, records.length - 1));
    const rows: Row[] = [];
    const dividerAt = this.showAll && finished.length ? active.length : -1;
    const compact = this.compact(width);
    const inner = this.innerWidth(width);
    records.slice(0, LIST_LIMIT).forEach((task, position) => {
      if (position === dividerAt) rows.push({ text: theme.fg("dim", `── 已结束 ${finished.length} ──`) });
      const glyph = STATUS_GLYPH[task.status];
      const note = taskNote(task);
      const cursor = position === this.index ? "❯" : " ";
      const left = `${cursor} ${theme.fg(glyph.color, glyph.text)} ${theme.fg("text", oneLineText(task.name))}`;
      if (compact || !note) {
        rows.push({ text: left, selected: position === this.index });
        return;
      }
      const gap = Math.max(1, inner - visibleWidth(left) - visibleWidth(note));
      rows.push({ text: `${left}${" ".repeat(gap)}${theme.fg("dim", note)}`, selected: position === this.index });
    });
    if (records.length > LIST_LIMIT) rows.push({ text: theme.fg("dim", `…还有 ${records.length - LIST_LIMIT} 个`) });
    return rows;
  }

  private detailRows(width: number): Row[] {
    const task = this.records().find((item) => item.id === this.detailId);
    if (!task) {
      this.detailId = undefined;
      return this.listRows(width);
    }
    const theme = this.init.theme;
    const component = new Markdown(detailDocument(task), 0, 0, getMarkdownTheme());
    const lines = component.render(Math.max(20, this.innerWidth(width)));
    const maxScroll = Math.max(0, lines.length - DETAIL_ROWS);
    this.scroll = Math.min(this.scroll, maxScroll);
    const rows: Row[] = lines.slice(this.scroll, this.scroll + DETAIL_ROWS).map((text) => ({ text }));
    if (lines.length > DETAIL_ROWS) {
      const from = this.scroll + 1;
      const to = Math.min(lines.length, this.scroll + DETAIL_ROWS);
      rows.push({ text: theme.fg("dim", `${from}-${to}/${lines.length} · PgUp/PgDn 滚动`) });
    }
    return rows;
  }

  private footerRows(width: number): Row[] {
    const theme = this.init.theme;
    const compact = this.compact(width);
    if (this.confirm) {
      const text = compact
        ? `再按 s 停止 ${oneLineText(this.confirm.name)}（Esc 取消）`
        : `再按 s 停止 ${oneLineText(this.confirm.name)} · 无待回传结果时不能恢复（Esc 取消）`;
      return [{ text: theme.fg("warning", text) }];
    }
    const rows: Row[] = [];
    if (this.error) rows.push({ text: theme.fg("error", oneLineText(this.error)) });
    else if (this.notice) rows.push({ text: theme.fg("success", oneLineText(this.notice)) });
    const hints = this.detailId
      ? (compact ? "Esc 返回 · PgUp/PgDn · s · r" : "Esc 返回 · PgUp/PgDn 滚动 · s 停止 · r 恢复/重新启动")
      : compact
        ? `↑↓ · Enter · s · r · a ${this.showAll ? "仅活跃" : "全部"} · Esc`
        : `↑↓ 移动 · Enter 详情 · s 停止 · r 恢复/重新启动 · a ${this.showAll ? "仅活跃" : "全部"} · Esc 关闭`;
    rows.push({ text: theme.fg("dim", hints) });
    return rows;
  }

  render(width: number): string[] {
    const rows: Row[] = [this.titleRow(width), { text: "", divider: true }];
    rows.push(...(this.detailId ? this.detailRows(width) : this.listRows(width)));
    rows.push({ text: "", divider: true });
    rows.push(...this.footerRows(width));
    return rows.map((row) => this.paint(row, width));
  }

  invalidate(): void {
    // 每次 render 都从运行时读取最新状态，无需缓存。
  }
}

/** 打开任务面板；初始 id 存在时直接进入详情。 */
export async function openTaskPanel(runtime: MonitorRuntime, ctx: ExtensionCommandContext, initialId?: string, showAll = false, outputPad = 1): Promise<void> {
  runtime.setPanelOpen(true);
  try {
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
      new MonitorPanel({ runtime, ctx, tui, theme, done, initialId, showAll, outputPad }), {
      overlay: true,
      overlayOptions: { width: "80%", minWidth: 30, maxHeight: "85%", margin: 1 },
    });
  } finally {
    runtime.setPanelOpen(false);
  }
}
