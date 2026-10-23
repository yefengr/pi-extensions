import type {
  Component,
  Focusable,
  KeybindingsManager,
  SettingItem,
  SettingsListTheme,
} from "@earendil-works/pi-tui";
import { SettingsList } from "@earendil-works/pi-tui";
import { EVENT_KEYS, loadConfig, saveConfig } from "../settings.js";
import type { NotifyConfig, NotifyEventKey } from "../types.js";
import {
  type PanelFeedback,
  type PanelTheme,
  type PanelView,
  keyHint,
  panelChromeRows,
  panelContentWidth,
  renderPanel,
  renderShortPanel,
  shortScreenNotice,
  trimTrailingBlank,
  visibleWidthSafe,
} from "../ui.js";
import { ModelPickerPage, type ModelOption } from "./model-picker.js";

const EVENT_LABELS: Record<NotifyEventKey, string> = {
  agent_end: "事件：Agent 运行结束",
  agent_settled: "事件：Agent 已完成",
  session_shutdown: "事件：会话结束",
};

const TOGGLE_VALUES = ["已启用", "已关闭"];

type SettingId =
  | "enabled"
  | "recap.enabled"
  | "recap.model"
  | "event.agent_end"
  | "event.agent_settled"
  | "event.session_shutdown"
  | "save";

const SETTING_ORDER: readonly SettingId[] = [
  "enabled",
  "recap.enabled",
  "recap.model",
  "event.agent_end",
  "event.agent_settled",
  "event.session_shutdown",
  "save",
];

/** 面板容纳标题、列表和操作提示所需的最小高度预算。 */
const MIN_SETTINGS_ROWS = 10;

export interface NotifySettingsOverlayOptions {
  models: ModelOption[];
  keybindings: KeybindingsManager;
  theme: PanelTheme;
  /** 有效覆盖层行预算（调用方已按终端高度和 80% 上限换算）。 */
  getRows: () => number;
  /** Pi 的 outputPad：1 时由本外壳在正文/标题/提示外侧留一列。 */
  outputPad?: number;
}

/**
 * 通知设置面板：SettingsList 负责设置项与取值切换，模型选择切换到原生
 * Input + SelectList 子页面。所有修改先写入整页草稿，只有「保存设置」写盘。
 * 选择状态由稳定 id 维护，导航/翻页由包装层处理后再交给原生列表。
 */
export class NotifySettingsOverlay implements Component, Focusable {
  private readonly options: NotifySettingsOverlayOptions;
  private draft: NotifyConfig;
  private baseline: string;
  private page: "list" | "model" = "list";
  private modelPage: ModelPickerPage | null = null;
  private list: SettingsList | null = null;
  private listMaxVisible = 0;
  private selectedId: SettingId = "enabled";
  private feedback: PanelFeedback | null = null;
  private focusState = false;

  onClose?: () => void;
  requestRender?: () => void;

  constructor(options: NotifySettingsOverlayOptions) {
    this.options = options;
    this.draft = loadConfig();
    this.baseline = serialize(this.draft);
  }

  get focused(): boolean {
    return this.focusState;
  }

  set focused(value: boolean) {
    this.focusState = value;
    if (this.modelPage) this.modelPage.focused = value;
  }

  setTheme(theme: PanelTheme): void {
    this.options.theme = theme;
    this.list = null;
    this.modelPage?.setTheme(theme);
  }

  invalidate(): void {
    this.list = null;
    this.modelPage?.invalidate();
  }

  handleInput(data: string): void {
    if (this.page === "model" && this.modelPage) {
      this.modelPage.handleInput(data);
      return;
    }
    const kb = this.options.keybindings;
    if (kb.matches(data, "tui.select.cancel")) {
      this.onClose?.();
      return;
    }
    // 短屏不渲染列表，禁止对不可见项确认、切换或保存。
    if (this.isShortScreen()) return;
    // 输入可能早于首次渲染：先按当前预算建立原生列表，避免导航/确认落到空对象。
    this.ensureList(this.listRows(this.budget()));

    if (kb.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }
    if (kb.matches(data, "tui.select.pageUp")) {
      this.moveSelection(-this.pageSize());
      return;
    }
    if (kb.matches(data, "tui.select.pageDown")) {
      this.moveSelection(this.pageSize());
      return;
    }
    if (kb.matches(data, "tui.select.confirm")) {
      if (this.selectedId === "recap.model") {
        this.openModelPicker();
        return;
      }
      if (this.selectedId === "save") {
        this.save();
        return;
      }
    }
    this.list?.handleInput(data);
  }

  render(width: number): string[] {
    if (this.page === "model" && this.modelPage) return this.modelPage.render(width);

    const budget = this.budget();
    if (budget <= 0) return [];
    const short = budget < MIN_SETTINGS_ROWS;
    const hint = this.hintText(panelContentWidth(width, this.outputPad()), short);
    if (short) {
      return renderShortPanel(this.options.theme, width, budget, {
        title: "通知设置",
        status: "窗口过小",
        notice: shortScreenNotice(this.options.theme),
        hint,
      }, this.outputPad());
    }

    const view: PanelView = {
      title: "通知设置",
      status: this.isDirty() ? "草稿未保存" : "与磁盘一致",
      body: [],
      mode: "草稿模式：修改只保留在本面板，选择「保存设置」后写入磁盘；取消不落盘",
      feedback: this.feedback,
      hint,
    };
    const inner = panelContentWidth(width, this.outputPad());
    this.ensureList(this.listRows(budget));
    view.body = this.list ? trimTrailingBlank(this.list.render(inner)) : [];
    return renderPanel(this.options.theme, width, view, this.outputPad());
  }

  private hintText(width: number, minimal: boolean): string {
    const kb = this.options.keybindings;
    const cancel = `${keyHint(kb, "tui.select.cancel")} 取消`;
    if (minimal) return cancel;
    const full = [
      `${keyHint(kb, "tui.select.up")}/${keyHint(kb, "tui.select.down")} 移动`,
      `${keyHint(kb, "tui.select.pageUp")}/${keyHint(kb, "tui.select.pageDown")} 翻页`,
      `${keyHint(kb, "tui.select.confirm")} 修改`,
      "Space 开关",
      `${keyHint(kb, "tui.select.cancel")} 取消（不保存）`,
    ].join(" · ");
    return visibleWidthSafe(full) <= width ? full : cancel;
  }

  private isDirty(): boolean {
    return serialize(this.draft) !== this.baseline;
  }

  private isShortScreen(): boolean {
    return this.budget() < MIN_SETTINGS_ROWS;
  }

  private budget(): number {
    return Math.max(0, this.options.getRows());
  }

  private outputPad(): number {
    return this.options.outputPad === 0 ? 0 : 1;
  }

  private listRows(budget: number): number {
    const chrome = panelChromeRows({ mode: "mode", feedback: this.feedback });
    const available = Math.max(1, budget - chrome);
    if (SETTING_ORDER.length <= available) return SETTING_ORDER.length;
    return Math.max(1, available - 1);
  }

  private pageSize(): number {
    return Math.max(1, this.listRows(this.budget()));
  }

  /** 上下移动沿用原生列表的 wrap 行为，翻页按实际可见行数并在边界停下。 */
  private moveSelection(delta: number): void {
    const index = SETTING_ORDER.indexOf(this.selectedId);
    const count = SETTING_ORDER.length;
    let target: number;
    if (Math.abs(delta) === 1) {
      target = (index + delta + count) % count;
    } else {
      target = Math.max(0, Math.min(count - 1, index + delta));
    }
    this.selectedId = SETTING_ORDER[target] ?? "enabled";
    this.list?.selectItem(this.selectedId);
  }

  private ensureList(maxVisible: number): void {
    if (this.list && this.listMaxVisible === maxVisible) return;
    this.listMaxVisible = maxVisible;
    const list = new SettingsList(
      this.buildItems(),
      maxVisible,
      this.settingsTheme(),
      (id, value) => this.applyChange(id, value),
      () => this.onClose?.(),
    );
    list.selectItem(this.selectedId);
    this.list = list;
  }

  private buildItems(): SettingItem[] {
    return SETTING_ORDER.map((id) => ({
      id,
      label: this.labelFor(id),
      currentValue: this.valueFor(id),
      ...(id === "recap.model" || id === "save" ? {} : { values: TOGGLE_VALUES }),
    }));
  }

  private labelFor(id: SettingId): string {
    switch (id) {
      case "enabled":
        return "启用通知";
      case "recap.enabled":
        return "启用 recap";
      case "recap.model":
        return "Recap 模型";
      case "save":
        return "保存设置";
      default:
        return EVENT_LABELS[eventKey(id)];
    }
  }

  private valueFor(id: SettingId): string {
    switch (id) {
      case "enabled":
        return toggleText(this.draft.enabled);
      case "recap.enabled":
        return toggleText(this.draft.recap.enabled);
      case "recap.model":
        return this.draft.recap.model ?? "未选择";
      case "save":
        return "写入配置文件";
      default:
        return toggleText(this.draft.events[eventKey(id)].enabled);
    }
  }

  private applyChange(id: string, value: string): void {
    const enabled = value === TOGGLE_VALUES[0];
    if (id === "enabled") this.draft.enabled = enabled;
    else if (id === "recap.enabled") this.draft.recap.enabled = enabled;
    else if (id.startsWith("event.")) this.draft.events[eventKey(id)].enabled = enabled;
    else return;
    this.feedback = null;
    this.requestRender?.();
  }

  private openModelPicker(): void {
    const page = new ModelPickerPage({
      models: this.options.models,
      keybindings: this.options.keybindings,
      theme: this.options.theme,
      getRows: this.options.getRows,
      outputPad: this.options.outputPad,
      title: "Recap 模型选择",
      mode: "草稿模式：选定的模型只更新草稿，返回后选择「保存设置」才写入磁盘",
      initialRef: this.draft.recap.model,
    });
    page.focused = this.focusState;
    page.requestRender = () => this.requestRender?.();
    page.onCancel = () => {
      this.page = "list";
      this.requestRender?.();
    };
    page.onConfirm = (ref) => {
      this.draft.recap.model = ref;
      this.feedback = { text: `草稿：模型改为 ${ref}（尚未写入磁盘）`, level: "warning" };
      this.page = "list";
      this.list?.updateValue("recap.model", ref);
      this.requestRender?.();
    };
    this.modelPage = page;
    this.page = "model";
    this.requestRender?.();
  }

  private save(): void {
    try {
      saveConfig(this.draft);
      this.baseline = serialize(this.draft);
      this.feedback = { text: "设置已保存到 notify.json", level: "success" };
    } catch (error) {
      this.feedback = {
        text: `保存失败：${describeError(error)}。草稿仍保留，可修正后重试，或按取消返回`,
        level: "error",
      };
    }
    this.requestRender?.();
  }

  private settingsTheme(): SettingsListTheme {
    const theme = this.options.theme;
    return {
      label: (text, selected) => (selected ? theme.bold(theme.fg("accent", text)) : theme.fg("text", text)),
      value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
      description: (text) => theme.fg("dim", text),
      cursor: theme.fg("accent", "▸ "),
      // 原生列表自带提示行会与本面板提示重复，禁用搜索后此处留空。
      hint: () => "",
    };
  }
}

function toggleText(enabled: boolean): string {
  return enabled ? TOGGLE_VALUES[0]! : TOGGLE_VALUES[1]!;
}

function eventKey(id: string): NotifyEventKey {
  const key = id.slice("event.".length);
  return EVENT_KEYS.find((candidate) => candidate === key) ?? "agent_end";
}

function serialize(config: NotifyConfig): string {
  return JSON.stringify(config);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
