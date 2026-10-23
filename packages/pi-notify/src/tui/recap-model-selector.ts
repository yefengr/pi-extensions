import type { Component, Focusable, KeybindingsManager } from "@earendil-works/pi-tui";
import { loadConfig, saveConfig } from "../settings.js";
import { type PanelFeedback, type PanelTheme } from "../ui.js";
import { ModelPickerPage, type ModelOption } from "./model-picker.js";

export interface RecapModelSelectorOptions {
  keybindings: KeybindingsManager;
  theme: PanelTheme;
  getRows: () => number;
  /** Pi 的 outputPad：透传给内层 ModelPickerPage 的统一外壳。 */
  outputPad?: number;
}

/**
 * `/notify:recap-model` 的独立模型选择面板：确认后立即写入配置。
 * 与设置面板内的模型子页面不同，这里不维护整页草稿。
 */
export class RecapModelSelectorOverlay implements Component, Focusable {
  private readonly options: RecapModelSelectorOptions;
  private readonly page: ModelPickerPage;
  private feedback: PanelFeedback | null = null;
  private focusState = false;

  onClose?: () => void;
  requestRender?: () => void;

  constructor(models: ModelOption[], options: RecapModelSelectorOptions) {
    this.options = options;
    this.page = new ModelPickerPage({
      models,
      keybindings: options.keybindings,
      theme: options.theme,
      getRows: options.getRows,
      outputPad: options.outputPad,
      title: "Recap 模型选择",
      mode: "确认后立即写入 notify.json；Esc 返回不修改配置",
      initialRef: loadConfig().recap.model,
    });
    this.page.onCancel = () => this.onClose?.();
    this.page.onConfirm = (ref) => this.persist(ref);
  }

  get focused(): boolean {
    return this.focusState;
  }

  /** 包装组件必须把外部焦点传播给内层原生 Input，输入法候选才能正确定位。 */
  set focused(value: boolean) {
    this.focusState = value;
    this.page.focused = value;
  }

  setTheme(theme: PanelTheme): void {
    this.options.theme = theme;
    this.page.setTheme(theme);
  }

  invalidate(): void {
    this.page.invalidate();
  }

  handleInput(data: string): void {
    this.page.handleInput(data);
  }

  render(width: number): string[] {
    return this.page.render(width);
  }

  private persist(ref: string): void {
    try {
      const config = loadConfig();
      config.recap.model = ref;
      saveConfig(config);
      this.feedback = { text: `模型已保存：${ref}`, level: "success" };
      this.page.setFeedback(this.feedback);
    } catch (error) {
      this.feedback = {
        text: `保存失败：${describeError(error)}。请检查配置路径权限后重试`,
        level: "error",
      };
      this.page.setFeedback(this.feedback);
    }
    this.requestRender?.();
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
