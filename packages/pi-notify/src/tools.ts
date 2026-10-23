import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { NOTIFY_TOOL_NAME } from "./event-contract.js";
import { loadConfig } from "./settings.js";
import { dispatchNotification } from "./events.js";
import type { NotifyUserParams } from "./types.js";

const NotifyUserSchema = Type.Object({
  message: Type.String({ description: "通知正文" }),
  title: Type.Optional(Type.String({ description: "通知标题" })),
  level: Type.Optional(Type.Union([
    Type.Literal("info"),
    Type.Literal("warning"),
    Type.Literal("error"),
  ], { description: "通知级别，默认 info" })),
});

export function registerNotifyTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: NOTIFY_TOOL_NAME,
    label: "Notify User",
    description: "向当前受支持的本地终端发送通知。终端不受支持时返回 unsupported。",
    parameters: NotifyUserSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext) {
      const { message, title, level = "info" } = params as NotifyUserParams;
      const result = await dispatchNotification(
        pi,
        title || "Pi 通知",
        message,
        "agent_tool",
        loadConfig(),
        level,
      );
      return {
        content: [{ type: "text" as const, text: formatResult(result.status, result.error) }],
        details: result,
      };
    },
  });
}

function formatResult(status: string, error?: string): string {
  return error ? `通知状态：${status}\n${error}` : `通知状态：${status}`;
}
