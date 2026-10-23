import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { createPanelKeymap, type PanelKeymap } from "./panel-keymap.ts";
import {
  OVERLAY_MARGIN, OVERLAY_MAX_HEIGHT, OVERLAY_MIN_WIDTH, OVERLAY_WIDTH,
  buildPanelFrame, detailDocument, innerWidth, panelBodyHeight, panelIsTooNarrow, panelIsTooSmall, panelMessageRows,
  statusLabel, visibleTasks,
  type PanelState,
} from "./panel-view.ts";
import type { MonitorRecord } from "./types.ts";
import type { MonitorRuntime } from "./runtime.ts";

export { buildPanelFrame, detailDocument, panelBodyHeight, panelIsTooNarrow, panelIsTooSmall, panelMessageRows, visibleTasks } from "./panel-view.ts";

const FALLBACK_TERMINAL_ROWS = 24;
const FALLBACK_RENDER_WIDTH = 80;

interface PanelInit {
  runtime: MonitorRuntime;
  ctx: ExtensionCommandContext;
  tui: TUI;
  theme: Theme;
  done: () => void;
  keybindings?: KeybindingsManager;
  initialId?: string;
  showAll?: boolean;
  /** Pi 的 outputPad 设置：1 时左右各留一列。 */
  outputPad?: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 面板本身不读取 process.stdout；终端尺寸由 TUI 注入，测试可传固定值。 */
function terminalRows(tui: TUI): number {
  const rows = (tui as TUI & { terminal?: { rows?: number } }).terminal?.rows;
  return typeof rows === "number" && rows > 0 ? rows : FALLBACK_TERMINAL_ROWS;
}

export class MonitorPanel implements Focusable {
  focused = false;

  private readonly init: PanelInit;
  private readonly keymap: PanelKeymap;
  private showAll: boolean;
  private selectedId?: string;
  /** 最近一次同步的可见索引，只在目标消失时作为可见回退依据。 */
  private selectedIndex = 0;
  private detailId?: string;
  private detailScroll = 0;
  private listTop = 0;
  private confirm?: { id: string; name: string };
  private error?: string;
  private notice?: string;
  private readError?: string;
  private busy = false;
  private disposed = false;
  private closed = false;
  private lastWidth = FALLBACK_RENDER_WIDTH;
  /** 主题或详情状态变化后递增，用于丢弃旧 Markdown 渲染缓存。 */
  private themeEpoch = 0;
  private markdown?: { key: string; lines: string[] };
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(init: PanelInit) {
    this.init = init;
    this.keymap = createPanelKeymap(init.keybindings);
    this.showAll = init.showAll === true;
    if (init.initialId) this.resolveInitialId(init.initialId);
    this.sync();
    // 引擎在面板打开期间继续检查，定时同步选择与状态后重绘。
    this.timer = setInterval(() => {
      if (this.disposed || this.closed) return;
      this.sync();
      this.init.tui.requestRender();
    }, 1_000);
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
  }

  invalidate(): void {
    // 主题或缓存需要重建：旧 ANSI 颜色与 Markdown 行全部丢弃。
    this.themeEpoch += 1;
    this.markdown = undefined;
  }

  handleInput(data: string): void {
    if (this.disposed || this.closed) return;
    // 短屏和极窄屏先处理取消：不可见的目标不得响应导航、详情或业务操作。
    if (this.keymap.matches(data, "cancel")) {
      this.handleCancel();
      return;
    }
    if (this.inputBlocked()) return;
    this.notice = undefined;
    // 输入前同步一次：目标消失、列表重排都会在按键生效前反映到选择上。
    const moved = this.sync();
    // 同步刚把选中或详情目标换成另一个任务时，本次业务键只用于呈现新目标，不得落到新对象上。
    if ((moved.selection || moved.detail) && this.isBusinessKey(data)) {
      this.refresh();
      return;
    }
    if (this.detailId) this.handleDetail(data);
    else this.handleList(data);
  }

  /** 停止、恢复、打开详情都作用于具体任务；导航与视图切换不针对目标。 */
  private isBusinessKey(data: string): boolean {
    return data === "s" || data === "r" || this.keymap.matches(data, "confirm");
  }

  /** 尺寸不足以显示主体时只保留退出；判断与布局共用同一套纯函数。 */
  private inputBlocked(): boolean {
    return panelIsTooSmall(terminalRows(this.init.tui))
      || panelIsTooNarrow(this.lastWidth, this.init.outputPad ?? 1);
  }

  private handleCancel(): void {
    // 短屏隐藏了列表和详情，逐层返回没有可见反馈，直接退出。
    if (this.inputBlocked()) {
      this.close();
      return;
    }
    if (this.confirm) {
      this.confirm = undefined;
      this.refresh();
      return;
    }
    if (this.detailId) {
      this.detailId = undefined;
      this.detailScroll = 0;
      this.refresh();
      return;
    }
    this.close();
  }

  private handleList(data: string): void {
    const records = this.read().records;
    if (data === "a") {
      this.showAll = !this.showAll;
      this.confirm = undefined;
      this.sync();
      this.refresh();
      return;
    }
    if (this.keymap.matches(data, "up") || this.keymap.matches(data, "down")) {
      this.move(this.keymap.matches(data, "up") ? -1 : 1, records);
      return;
    }
    if (this.keymap.matches(data, "pageUp") || this.keymap.matches(data, "pageDown")) {
      const step = this.bodyCapacity();
      this.move(this.keymap.matches(data, "pageUp") ? -step : step, records);
      return;
    }
    const task = this.selectedTask(records);
    if (!task) return;
    if (this.keymap.matches(data, "confirm")) {
      this.detailId = task.id;
      this.detailScroll = 0;
      this.refresh();
      return;
    }
    if (data === "s") this.requestStop(task);
    if (data === "r") this.resumeOrRestart(task);
  }

  private handleDetail(data: string): void {
    const task = this.read().records.find((item) => item.id === this.detailId);
    if (!task) {
      this.detailId = undefined;
      this.sync();
      this.refresh();
      return;
    }
    const step = Math.max(1, this.bodyCapacity());
    const maxScroll = Math.max(0, this.detailLines(task).length - step);
    if (this.keymap.matches(data, "up") || this.keymap.matches(data, "down")) {
      const delta = this.keymap.matches(data, "up") ? -1 : 1;
      this.detailScroll = Math.max(0, Math.min(this.detailScroll + delta, maxScroll));
      this.refresh();
      return;
    }
    if (this.keymap.matches(data, "pageUp") || this.keymap.matches(data, "pageDown")) {
      const delta = this.keymap.matches(data, "pageUp") ? -step : step;
      this.detailScroll = Math.max(0, Math.min(this.detailScroll + delta, maxScroll));
      this.refresh();
      return;
    }
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
    if (this.busy) {
      this.notice = "上一个操作尚未完成，请稍候";
      this.refresh();
      return;
    }
    try {
      const created = this.init.runtime.relaunch(this.init.ctx, task.id);
      this.error = undefined;
      this.notice = `已重新启动 ${task.name} → ${created.id.slice(0, 8)}（原任务保留为${statusLabel(task.status)}）`;
    } catch (error) {
      this.notice = undefined;
      this.error = messageOf(error);
    }
    this.sync();
    this.refresh();
  }

  /** busy 期间拒绝重复触发；关闭后的迟到结果不得更新页面。 */
  private run(action: "stop" | "resume", task: MonitorRecord): void {
    this.confirm = undefined;
    if (this.busy) {
      this.notice = "上一个操作尚未完成，请稍候";
      this.refresh();
      return;
    }
    this.busy = true;
    this.error = undefined;
    this.notice = undefined;
    this.refresh();
    void this.init.runtime.act(action, { id: task.id }, this.init.ctx)
      .then(() => {
        if (this.disposed || this.closed) return;
        this.busy = false;
        this.error = undefined;
        this.notice = action === "stop" ? `已停止 ${task.name}` : `已恢复 ${task.name}`;
        this.sync();
        this.refresh();
      })
      .catch((error: unknown) => {
        if (this.disposed || this.closed) return;
        this.busy = false;
        this.notice = undefined;
        this.error = messageOf(error);
        this.refresh();
      });
  }

  private resolveInitialId(initialId: string): void {
    const { records } = this.read();
    const matches = records.filter((task) => task.id === initialId || task.id.startsWith(initialId));
    if (matches.length === 1) this.detailId = matches[0].id;
    else if (matches.length > 1) this.error = `id 前缀不唯一：${initialId}`;
    else this.error = `找不到监听任务：${initialId.slice(0, 8)}`;
  }

  /** 在输入与定时刷新时同步选择：业务状态只在这里变化，render 不写选择。 */
  private sync(): { selection: boolean; detail: boolean } {
    const { records, failure } = this.read();
    this.readError = failure;
    const shown = visibleTasks(records, this.showAll);
    let detail = false;
    if (this.detailId && !records.some((task) => task.id === this.detailId)) {
      this.detailId = undefined;
      this.detailScroll = 0;
      detail = true;
    }
    if (this.confirm && !shown.some((task) => task.id === this.confirm?.id)) {
      this.confirm = undefined;
      this.error = undefined;
      this.notice = "停止确认目标已不在列表，操作已取消";
    }
    const found = shown.findIndex((task) => task.id === this.selectedId);
    if (found >= 0) {
      this.selectedIndex = found;
      return { selection: false, detail };
    }
    const previousId = this.selectedId;
    const fallback = Math.max(0, Math.min(this.selectedIndex, shown.length - 1));
    this.selectedIndex = fallback;
    this.selectedId = shown[fallback]?.id;
    // 选中目标消失时给出可见回退；确认取消的提示优先保留。
    if (previousId && this.selectedId && !this.notice) {
      this.notice = `所选任务已不在列表，已切换到 ${shown[fallback].name}`;
    }
    return { selection: previousId !== undefined && this.selectedId !== previousId, detail };
  }

  private move(delta: number, records: MonitorRecord[]): void {
    const shown = visibleTasks(records, this.showAll);
    if (!shown.length) return;
    const current = Math.max(0, shown.findIndex((task) => task.id === this.selectedId));
    const next = Math.max(0, Math.min(current + delta, shown.length - 1));
    this.selectedId = shown[next].id;
    this.selectedIndex = next;
    this.confirm = undefined;
    this.refresh();
  }

  private selectedTask(records: MonitorRecord[]): MonitorRecord | undefined {
    const shown = visibleTasks(records, this.showAll);
    return shown.find((task) => task.id === this.selectedId);
  }

  private refresh(): void {
    if (this.disposed || this.closed) return;
    this.init.tui.requestRender();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.init.done();
  }

  private bodyCapacity(): number {
    return panelBodyHeight(terminalRows(this.init.tui), panelMessageRows(this.panelState(), this.readError));
  }

  private panelState(): PanelState {
    return {
      showAll: this.showAll, selectedId: this.selectedId, detailId: this.detailId,
      listTop: this.listTop, detailScroll: this.detailScroll,
      confirm: this.confirm, error: this.error, notice: this.notice, busy: this.busy,
    };
  }

  /** 一次读取同时返回记录与失败信息；render 只展示，不改业务错误状态。 */
  private read(): { records: MonitorRecord[]; failure?: string } {
    try {
      return { records: this.init.runtime.records(this.init.ctx) };
    } catch (error) {
      return { records: [], failure: messageOf(error) };
    }
  }

  /** Markdown 与滚动计数共用面板内宽；不再抬到固定下限，否则窄面板正文会被整段裁掉。 */
  private markdownWidth(): number {
    return Math.max(1, innerWidth(this.lastWidth, this.init.outputPad ?? 1));
  }

  /** Markdown 行按任务状态、宽度和主题版本缓存，主题变化后由 invalidate 清空。 */
  private detailLines(task: MonitorRecord): string[] {
    const width = this.markdownWidth();
    const key = [
      this.themeEpoch, task.id, width, task.status, task.pending.length,
      task.lastCheckAt ?? 0, task.lastResult?.id ?? "", task.failures,
    ].join(":");
    if (this.markdown?.key === key) return this.markdown.lines;
    const component = new Markdown(detailDocument(task), 0, 0, getMarkdownTheme());
    const lines = component.render(width);
    this.markdown = { key, lines };
    return lines;
  }

  render(width: number): string[] {
    this.lastWidth = width;
    const { records, failure } = this.read();
    const state = this.panelState();
    const detailTask = this.detailId ? records.find((task) => task.id === this.detailId) : undefined;
    const detailReady = detailTask
      && !panelIsTooSmall(terminalRows(this.init.tui))
      && !panelIsTooNarrow(width, this.init.outputPad ?? 1);
    const detail = detailReady
      ? { task: detailTask, lines: this.detailLines(detailTask) }
      : undefined;
    const frame = buildPanelFrame({
      records, detail, failure, width,
      terminalRows: terminalRows(this.init.tui),
      outputPad: this.init.outputPad ?? 1,
      theme: this.init.theme,
      keymap: this.keymap,
      state,
    });
    // 只缓存布局结果，不改变业务选择。
    this.listTop = frame.listTop;
    this.detailScroll = frame.detailScroll;
    return frame.rows;
  }
}

/** 打开任务面板；初始 id 存在时直接进入详情。 */
export async function openTaskPanel(runtime: MonitorRuntime, ctx: ExtensionCommandContext, initialId?: string, showAll = false, outputPad = 1): Promise<void> {
  runtime.setPanelOpen(true);
  try {
    await ctx.ui.custom<void>((tui, theme, keybindings, done) =>
      new MonitorPanel({ runtime, ctx, tui, theme, keybindings, done, initialId, showAll, outputPad }), {
      overlay: true,
      overlayOptions: {
        width: OVERLAY_WIDTH,
        minWidth: OVERLAY_MIN_WIDTH,
        maxHeight: OVERLAY_MAX_HEIGHT,
        margin: OVERLAY_MARGIN,
      },
    });
  } finally {
    runtime.setPanelOpen(false);
  }
}
