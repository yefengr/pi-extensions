import type { Component, Focusable, KeybindingsManager, SelectItem, SelectListTheme } from "@earendil-works/pi-tui";
import { Input, SelectList } from "@earendil-works/pi-tui";
import {
  type PanelFeedback,
  type PanelTheme,
  fitLine,
  keyHint,
  panelChromeRows,
  panelContentWidth,
  renderPanel,
  renderShortPanel,
  shortScreenNotice,
  visibleWidthSafe,
} from "../ui.js";

export interface ModelOption {
  provider: string;
  id: string;
  name?: string;
}

/** 面板容纳标题、筛选框和至少一行候选所需的最小高度预算。 */
const MIN_PICKER_ROWS = 10;

export function modelRef(model: ModelOption): string {
  return `${model.provider}/${model.id}`;
}

export interface ModelPickerOptions {
  models: ModelOption[];
  keybindings: KeybindingsManager;
  theme: PanelTheme;
  /** 有效覆盖层行预算（调用方已按终端高度和 80% 上限换算）。 */
  getRows: () => number;
  /** Pi 的 outputPad：1 时由本外壳在正文/标题/提示外侧留一列。 */
  outputPad?: number;
  title?: string;
  mode?: string;
  initialRef?: string | null;
}

/**
 * Recap 模型选择页：原生 Input 负责输入、原生 SelectList 负责候选，
 * 筛选规则保留在业务层，只向调用方回报选中的 provider/id。
 */
export class ModelPickerPage implements Component, Focusable {
  private readonly options: ModelPickerOptions;
  private readonly input: Input;
  private list: SelectList | null = null;
  private filtered: ModelOption[];
  private layoutRows = 0;
  private selectedRef: string | null;
  private feedback: PanelFeedback | null = null;
  private focusState = false;

  onConfirm?: (ref: string) => void;
  onCancel?: () => void;
  requestRender?: () => void;

  constructor(options: ModelPickerOptions) {
    this.options = options;
    this.input = new Input({ prompt: "筛选: ", placeholder: "输入 provider 或模型名" });
    this.input.focused = false;
    this.input.onEscape = () => this.onCancel?.();
    this.filtered = [...options.models];
    this.selectedRef = options.initialRef ?? null;
  }

  get title(): string {
    return this.options.title ?? "Recap 模型选择";
  }

  get focused(): boolean {
    return this.focusState;
  }

  /** 包装层把焦点传播给原生 Input；短屏不渲染筛选框时不得保留焦点。 */
  set focused(value: boolean) {
    this.focusState = value;
    this.input.focused = value && !this.isShortScreen();
  }

  setTheme(theme: PanelTheme): void {
    this.options.theme = theme;
    this.list = null;
    this.input.invalidate();
  }

  invalidate(): void {
    this.list = null;
    this.input.invalidate();
  }

  handleInput(data: string): void {
    const kb = this.options.keybindings;
    if (kb.matches(data, "tui.select.cancel")) {
      this.onCancel?.();
      return;
    }
    if (this.isShortScreen()) return;

    if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
      this.ensureList(this.listRows());
      this.list?.handleInput(data);
      this.syncSelection();
      return;
    }
    if (kb.matches(data, "tui.select.pageUp") || kb.matches(data, "tui.select.pageDown")) {
      this.page(kb.matches(data, "tui.select.pageDown") ? 1 : -1);
      return;
    }
    if (kb.matches(data, "tui.select.confirm")) {
      this.confirm();
      return;
    }
    this.input.handleInput(data);
    const next = this.filterModels(this.input.getValue());
    if (!sameModels(next, this.filtered)) {
      this.filtered = next;
      this.feedback = null;
      this.rebuildList(this.layoutRows);
    }
  }

  render(width: number): string[] {
    const budget = this.budget();
    if (budget <= 0) return [];
    const short = budget < MIN_PICKER_ROWS;
    this.input.focused = this.focusState && !short;
    if (short) {
      return renderShortPanel(this.options.theme, width, budget, {
        title: this.title,
        status: "窗口过小",
        notice: shortScreenNotice(this.options.theme),
        hint: this.hintText(panelContentWidth(width, this.outputPad()), true),
      }, this.outputPad());
    }

    const inner = panelContentWidth(width, this.outputPad());
    this.ensureList(this.listRows());
    const body = [fitLine(this.input.render(inner)[0] ?? "", inner), ...(this.list?.render(inner) ?? [])];
    return renderPanel(this.options.theme, width, {
      title: this.title,
      status: `${this.filtered.length}/${this.options.models.length} 个模型`,
      body,
      mode: this.modeText(),
      feedback: this.feedback,
      hint: this.hintText(inner, false),
    }, this.outputPad());
  }

  /** 由调用方展示保存结果，页面本身不写盘。 */
  setFeedback(feedback: PanelFeedback | null): void {
    this.feedback = feedback;
  }

  private modeText(): string {
    if (this.options.mode) return this.options.mode;
    return `筛选规则：provider、模型 id 或名称包含输入内容 · 已筛选 ${this.filtered.length} 个`;
  }

  private hintText(width: number, minimal: boolean): string {
    const kb = this.options.keybindings;
    const cancel = `${keyHint(kb, "tui.select.cancel")} ${minimal ? "退出" : "返回"}`;
    if (minimal) return cancel;
    const full = [
      `${keyHint(kb, "tui.select.up")}/${keyHint(kb, "tui.select.down")} 移动`,
      `${keyHint(kb, "tui.select.pageUp")}/${keyHint(kb, "tui.select.pageDown")} 翻页`,
      `${keyHint(kb, "tui.select.confirm")} 选定`,
      "输入筛选",
      cancel,
    ].join(" · ");
    return visibleWidthSafe(full) <= width ? full : cancel;
  }

  private isShortScreen(): boolean {
    return this.budget() < MIN_PICKER_ROWS;
  }

  private budget(): number {
    return Math.max(0, this.options.getRows());
  }

  private outputPad(): number {
    return this.options.outputPad === 0 ? 0 : 1;
  }

  private listRows(): number {
    const budget = this.budget();
    const chrome = panelChromeRows({ mode: this.modeText(), feedback: this.feedback }) + 1;
    const available = Math.max(1, budget - chrome);
    const count = this.filtered.length;
    if (count <= available) return Math.max(1, count);
    return Math.max(1, available - 1);
  }

  private filterModels(query: string): ModelOption[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [...this.options.models];
    return this.options.models.filter((model) =>
      `${modelRef(model)} ${model.name ?? ""}`.toLowerCase().includes(needle),
    );
  }

  private ensureList(bodyRows: number): void {
    if (!this.list || this.layoutRows !== bodyRows) this.rebuildList(bodyRows);
  }

  private rebuildList(bodyRows = this.layoutRows): void {
    this.layoutRows = Math.max(1, bodyRows);
    const items: SelectItem[] = this.filtered.map((model) => ({
      value: modelRef(model),
      label: model.name ?? model.id,
      description: model.provider,
    }));
    const list = new SelectList(items, this.layoutRows, this.selectListTheme(this.options.theme));
    list.onSelectionChange = (item) => {
      this.selectedRef = item.value;
    };
    const index = this.filtered.findIndex((model) => modelRef(model) === this.selectedRef);
    list.setSelectedIndex(Math.max(0, index));
    this.list = list;
    this.syncSelection();
  }

  /** 原生列表是唯一选择来源，翻页/重排后把合法 ref 同步回来。 */
  private syncSelection(): void {
    const item = this.list?.getSelectedItem();
    if (item) this.selectedRef = item.value;
    else if (this.filtered.length === 0) this.selectedRef = null;
    else this.selectedRef = modelRef(this.filtered[Math.max(0, this.currentIndex())]!);
  }

  private currentIndex(): number {
    const index = this.filtered.findIndex((model) => modelRef(model) === this.selectedRef);
    return index >= 0 ? index : 0;
  }

  private page(direction: 1 | -1): void {
    if (this.filtered.length === 0) return;
    this.ensureList(this.listRows());
    const step = Math.max(1, this.layoutRows);
    const current = this.currentIndex();
    const target = Math.max(0, Math.min(this.filtered.length - 1, current + direction * step));
    this.list?.setSelectedIndex(target);
    this.syncSelection();
  }

  private selectListTheme(theme: PanelTheme): SelectListTheme {
    return {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", theme.bold(text)),
      description: (text) => theme.fg("dim", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    };
  }

  private confirm(): void {
    if (this.isShortScreen()) return;
    this.ensureList(this.listRows());
    const item = this.list?.getSelectedItem();
    if (!item) {
      this.feedback = { text: "没有匹配的模型，请调整筛选内容", level: "warning" };
      return;
    }
    this.selectedRef = item.value;
    this.onConfirm?.(item.value);
  }
}

function sameModels(left: ModelOption[], right: ModelOption[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((model, index) => {
    const other = right[index];
    return other !== undefined && modelRef(model) === modelRef(other);
  });
}
