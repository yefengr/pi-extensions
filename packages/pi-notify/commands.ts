import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RecapModelSelectorOverlay, type RecapModelOption } from "./tui/recap-model-selector.js";
import { NotifySettingsOverlay } from "./tui/settings-overlay.js";
import { loadConfig } from "./settings.js";
import { sendNativeNotification } from "./platforms/native.js";

export const NOTIFY_COMMANDS = {
  SETTINGS: "notify:settings",
  RECAP_MODEL: "notify:recap-model",
  TEST: "notify:test",
} as const;

export function registerNotifyCommands(pi: ExtensionAPI): void {
  pi.registerCommand(NOTIFY_COMMANDS.SETTINGS, {
    description: "配置本地终端通知和事件",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("通知设置需要交互式界面。", "warning");
        return;
      }
      const models = getModelOptions(ctx);
      ctx.ui.custom(
        (tui, theme, _keybindings, done) => {
          const overlay = new NotifySettingsOverlay();
          overlay.setTheme(theme);
          overlay.onClose = () => done(undefined);
          overlay.requestRender = () => tui.requestRender();
          overlay.onOpenModelSelector = () => {
            ctx.ui.custom(
              (innerTui, innerTheme, _innerKeybindings, innerDone) => {
                const selector = new RecapModelSelectorOverlay(models);
                selector.setTheme(innerTheme);
                selector.onClose = () => {
                  overlay.reload();
                  innerDone(undefined);
                };
                selector.requestRender = () => innerTui.requestRender();
                return {
                  render: (width: number) => selector.render(width),
                  invalidate: () => selector.invalidate(),
                  handleInput: (data: string) => {
                    selector.handleInput(data);
                    innerTui.requestRender();
                  },
                };
              },
              { overlay: true, overlayOptions: { width: "60%", minWidth: 40, anchor: "center", margin: 4 } },
            );
          };
          return {
            render: (width: number) => overlay.render(width),
            invalidate: () => overlay.invalidate(),
            handleInput: (data: string) => {
              overlay.handleInput(data);
              tui.requestRender();
            },
          };
        },
        { overlay: true, overlayOptions: { width: "80%", minWidth: 60, anchor: "center", margin: 2 } },
      );
    },
  });

  pi.registerCommand(NOTIFY_COMMANDS.RECAP_MODEL, {
    description: "选择通知 recap 模型",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("模型选择需要交互式界面。", "warning");
        return;
      }
      openModelSelector(ctx, getModelOptions(ctx));
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

function getModelOptions(ctx: ExtensionContext): RecapModelOption[] {
  return ctx.modelRegistry.getAvailable().map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
  }));
}

function openModelSelector(ctx: ExtensionContext, models: RecapModelOption[]): void {
  ctx.ui.custom(
    (tui, theme, _keybindings, done) => {
      const selector = new RecapModelSelectorOverlay(models);
      selector.setTheme(theme);
      selector.onClose = () => done(undefined);
      selector.requestRender = () => tui.requestRender();
      return {
        render: (width: number) => selector.render(width),
        invalidate: () => selector.invalidate(),
        handleInput: (data: string) => {
          selector.handleInput(data);
          tui.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions: { width: "60%", minWidth: 40, anchor: "center", margin: 4 } },
  );
}
