// ---- Narrow interfaces ----

/** The toast a settings mutation returns for the UI to display. */
export interface SettingsToast {
  message: string;
  level: "info" | "warning";
}

/** Narrow settings interface required by the subagents:settings command. */
export interface SubagentsSettingsManager {
  readonly maxConcurrent: number;
  readonly maxTurns: number;
  readonly wrapUpTurns: number;
  readonly maxDurationSeconds: number;
  readonly maxQueueWaitSeconds: number;
  readonly abortGraceSeconds: number;
  readonly consumedSessionRetentionMinutes: number;
  readonly unconsumedSessionRetentionMinutes: number;
  readonly abortAllOnInterrupt: boolean;
  applyMaxConcurrent(n: number): SettingsToast;
  applyMaxTurns(n: number): SettingsToast;
  applyWrapUpTurns(n: number): SettingsToast;
  applyMaxDurationSeconds(n: number): SettingsToast;
  applyMaxQueueWaitSeconds(n: number): SettingsToast;
  applyAbortGraceSeconds(n: number): SettingsToast;
  applyConsumedSessionRetentionMinutes(n: number): SettingsToast;
  applyUnconsumedSessionRetentionMinutes(n: number): SettingsToast;
  toggleAbortAllOnInterrupt(): SettingsToast;
}

/** Narrow UI interface — only the ctx.ui methods the settings handler calls. */
export interface SubagentsSettingsUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, defaultValue?: string): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

// ---- Descriptor table ----

/** Fields every setting needs to render its line in the select list. */
interface SettingDescriptorBase {
  /** Prefix used both to build the select option and to match the user's choice. */
  label: string;
  /** Current value rendered in the select option. */
  currentDisplay: (settings: SubagentsSettingsManager) => string | number;
}

/** Describes one numeric setting's prompt, validation, and apply behavior. */
interface NumericSettingDescriptor extends SettingDescriptorBase {
  kind: "numeric";
  /** Title shown on the input prompt. */
  inputTitle: string;
  /** Value pre-filled into the input box. */
  inputDefault: (settings: SubagentsSettingsManager) => string;
  /** Minimum accepted integer, inclusive. */
  minimum: number;
  /** Warning shown when the parsed value is below the minimum. */
  validationMessage: string;
  /** Applies the validated value and returns the toast to display. */
  apply: (settings: SubagentsSettingsManager, n: number) => SettingsToast;
}

/** Describes one boolean setting, flipped directly from the select list. */
interface ToggleSettingDescriptor extends SettingDescriptorBase {
  kind: "toggle";
  /** Flips the setting and returns the toast to display. */
  toggle: (settings: SubagentsSettingsManager) => SettingsToast;
}

type SettingDescriptor = NumericSettingDescriptor | ToggleSettingDescriptor;

/**
 * Settings list copy is intentionally Chinese and states the save model: every
 * entry applies immediately, so cancel only closes the list.
 */
const SETTINGS: readonly SettingDescriptor[] = [
  {
    kind: "numeric",
    label: "最大并发数",
    currentDisplay: (settings) => settings.maxConcurrent,
    inputTitle: "最大并发数（同时运行的后台子代理上限）",
    inputDefault: (settings) => String(settings.maxConcurrent),
    minimum: 1,
    validationMessage: "请输入正整数。",
    apply: (settings, n) => settings.applyMaxConcurrent(n),
  },
  {
    kind: "numeric",
    label: "最大轮次",
    currentDisplay: (settings) => settings.maxTurns,
    inputTitle: "最大轮次（达到后强制停止）",
    inputDefault: (settings) => String(settings.maxTurns),
    minimum: 1,
    validationMessage: "请输入正整数。",
    apply: (settings, n) => settings.applyMaxTurns(n),
  },
  {
    kind: "numeric",
    label: "收尾轮次",
    currentDisplay: (settings) => settings.wrapUpTurns,
    inputTitle: "收尾轮次（强制停止前预留的轮次，0 表示到达上限即停止）",
    inputDefault: (settings) => String(settings.wrapUpTurns),
    minimum: 0,
    validationMessage: "请输入 0 或正整数。",
    apply: (settings, n) => settings.applyWrapUpTurns(n),
  },
  {
    kind: "numeric",
    label: "最长运行时长",
    currentDisplay: (settings) => `${settings.maxDurationSeconds} 秒`,
    inputTitle: "最长运行时长（秒）",
    inputDefault: (settings) => String(settings.maxDurationSeconds),
    minimum: 1,
    validationMessage: "请输入正整数。",
    apply: (settings, n) => settings.applyMaxDurationSeconds(n),
  },
  {
    kind: "numeric",
    label: "最长排队等待",
    currentDisplay: (settings) => `${settings.maxQueueWaitSeconds} 秒`,
    inputTitle: "最长排队等待时长（秒）",
    inputDefault: (settings) => String(settings.maxQueueWaitSeconds),
    minimum: 1,
    validationMessage: "请输入正整数。",
    apply: (settings, n) => settings.applyMaxQueueWaitSeconds(n),
  },
  {
    kind: "numeric",
    label: "中止宽限期",
    currentDisplay: (settings) => `${settings.abortGraceSeconds} 秒`,
    inputTitle: "中止宽限期（秒）",
    inputDefault: (settings) => String(settings.abortGraceSeconds),
    minimum: 1,
    validationMessage: "请输入正整数。",
    apply: (settings, n) => settings.applyAbortGraceSeconds(n),
  },
  {
    kind: "numeric",
    label: "已消费会话保留",
    currentDisplay: (settings) => `${settings.consumedSessionRetentionMinutes} 分钟`,
    inputTitle: "已消费会话的保留时长（分钟）",
    inputDefault: (settings) => String(settings.consumedSessionRetentionMinutes),
    minimum: 1,
    validationMessage: "请输入正整数。",
    apply: (settings, n) => settings.applyConsumedSessionRetentionMinutes(n),
  },
  {
    kind: "numeric",
    label: "未消费会话保留",
    currentDisplay: (settings) => `${settings.unconsumedSessionRetentionMinutes} 分钟`,
    inputTitle: "未消费会话的保留时长（分钟，安全上限）",
    inputDefault: (settings) => String(settings.unconsumedSessionRetentionMinutes),
    minimum: 1,
    validationMessage: "请输入正整数。",
    apply: (settings, n) => settings.applyUnconsumedSessionRetentionMinutes(n),
  },
  {
    kind: "toggle",
    label: "ESC 中止全部子代理",
    currentDisplay: (settings) => (settings.abortAllOnInterrupt ? "开" : "关"),
    toggle: (settings) => settings.toggleAbortAllOnInterrupt(),
  },
];

// ---- Class ----

/**
 * Handler for the `/subagents:settings` slash command.
 *
 * Call `handle({ ui })` from the Pi command registration to open the interactive
 * settings list. Lifted from `AgentsMenuHandler.showSettings`.
 */
export class SubagentsSettingsHandler {
  constructor(private readonly settings: SubagentsSettingsManager) {}

  async handle({ ui }: { ui: SubagentsSettingsUI }): Promise<void> {
    const options = SETTINGS.map(
      (d) => `${d.label}（当前：${d.currentDisplay(this.settings)}）`,
    );
    const choice = await ui.select("子代理设置（修改立即生效）", options);
    if (!choice) return;

    const descriptor = SETTINGS.find((d) => choice.startsWith(d.label));
    if (!descriptor) return;

    if (descriptor.kind === "toggle") {
      const toast = descriptor.toggle(this.settings);
      ui.notify(toast.message, toast.level);
      return;
    }

    await this.promptNumeric(ui, descriptor);
  }

  /** Ask for a number, validate it against the descriptor, apply it, and notify. */
  private async promptNumeric(
    ui: SubagentsSettingsUI,
    descriptor: NumericSettingDescriptor,
  ): Promise<void> {
    const val = await ui.input(descriptor.inputTitle, descriptor.inputDefault(this.settings));
    if (!val) return;

    const n = parseInt(val, 10);
    if (n >= descriptor.minimum) {
      const toast = descriptor.apply(this.settings, n);
      ui.notify(toast.message, toast.level);
    } else {
      ui.notify(descriptor.validationMessage, "warning");
    }
  }
}
