import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RecapModelSelectorOverlay } from "./tui/recap-model-selector.js";
import type { ModelOption } from "./tui/model-picker.js";
import { NotifySettingsOverlay } from "./tui/settings-overlay.js";
import { loadConfig } from "./settings.js";
import { overlayRowBudget } from "./ui.js";
import { sendNativeNotification } from "./platforms/native.js";

export const NOTIFY_COMMANDS = {
  SETTINGS: "notify:settings",
  RECAP_MODEL: "notify:recap-model",
  TEST: "notify:test",
} as const;

/** 标准面板：80% 宽、最小 30 列、最高 80%、外边距 1。 */
const OVERLAY_OPTIONS = {
  overlay: true,
  overlayOptions: {
    width: "80%",
    minWidth: 30,
    maxHeight: "80%",
    anchor: "center",
    margin: 1,
  },
} as const;

export function registerNotifyCommands(pi: ExtensionAPI): void {
  pi.registerCommand(NOTIFY_COMMANDS.SETTINGS, {
    description: "配置本地终端通知和事件",
    handler: async (_args, ctx) => {
      if (!supportsCustomTui(ctx, "通知设置面板只能在交互式 TUI 中打开。")) return;
      const models = getModelOptions(ctx);
      const outputPad = pi.getSettings().outputPad ?? 1;
      await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
        const overlay = new NotifySettingsOverlay({
          models,
          keybindings,
          theme,
          getRows: overlayRows(tui),
          outputPad,
        });
        overlay.onClose = once(done);
        overlay.requestRender = () => tui.requestRender();
        return wrapFocusable(overlay, tui.requestRender);
      }, OVERLAY_OPTIONS);
    },
  });

  pi.registerCommand(NOTIFY_COMMANDS.RECAP_MODEL, {
    description: "选择通知 recap 模型",
    handler: async (_args, ctx) => {
      if (!supportsCustomTui(ctx, "模型选择面板只能在交互式 TUI 中打开。")) return;
      await openRecapModelSelector(ctx, getModelOptions(ctx), pi.getSettings().outputPad ?? 1);
    },
  });

  pi.registerCommand(NOTIFY_COMMANDS.TEST, {
    description: "发送本地终端测试通知",
    handler: async (_args, ctx) => {
      const config = loadConfig();
      if (!config.enabled) {
        ctx.ui.notify("测试结果：disabled（通知已关闭）", "warning");
        return;
      }
      const result = await sendNativeNotification(
        "Pi — 测试通知",
        `测试时间：${new Date().toLocaleTimeString()}`,
        "info",
      );
      const detail = result.terminal && result.protocol
        ? `\n终端：${result.terminal}\n协议：${result.protocol.toUpperCase()}`
        : "";
      const message = result.status === "sent"
        ? `测试结果：sent（已写入终端）${detail}`
        : `测试结果：${result.status}${result.error ? `\n${result.error}` : ""}${detail}`;
      const feedbackLevel = result.status === "sent"
        ? "info"
        : result.status === "failed"
          ? "error"
          : "warning";
      ctx.ui.notify(message, feedbackLevel);
    },
  });
}

function supportsCustomTui(ctx: ExtensionContext, message: string): boolean {
  if (ctx.mode === "tui" && ctx.hasUI) return true;
  ctx.ui.notify(`${message}当前模式请直接编辑 notify.json。`, "warning");
  return false;
}

function getModelOptions(ctx: ExtensionContext): ModelOption[] {
  return ctx.modelRegistry.getAvailable().map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
  }));
}

/** 注入有效覆盖层预算：终端高度的 80% 与 rows-2 取小，而非终端全高。 */
function overlayRows(tui: { terminal: { rows: number } }): () => number {
  return () => overlayRowBudget(tui.terminal.rows);
}

/** done() 只允许结束一次，避免取消与确认路径重复收尾。 */
function once<T>(done: (value?: T) => void): () => void {
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    done(undefined);
  };
}

function wrapFocusable(
  overlay: { render: (width: number) => string[]; invalidate: () => void; handleInput: (data: string) => void; focused: boolean },
  requestRender: () => void,
): {
  render: (width: number) => string[];
  invalidate: () => void;
  handleInput: (data: string) => void;
  focused: boolean;
} {
  return {
    render: (width: number) => overlay.render(width),
    invalidate: () => overlay.invalidate(),
    handleInput: (data: string) => {
      overlay.handleInput(data);
      requestRender();
    },
    get focused() {
      return overlay.focused;
    },
    set focused(value: boolean) {
      overlay.focused = value;
    },
  };
}

async function openRecapModelSelector(ctx: ExtensionContext, models: ModelOption[], outputPad: number): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    const overlay = new RecapModelSelectorOverlay(models, {
      keybindings,
      theme,
      getRows: overlayRows(tui),
      outputPad,
    });
    overlay.onClose = once(done);
    overlay.requestRender = () => tui.requestRender();
    return wrapFocusable(overlay, tui.requestRender);
  }, OVERLAY_OPTIONS);
}
