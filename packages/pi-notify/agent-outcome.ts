import type { NotificationLevel } from "./types.js";

export type AgentOutcome = {
  kind: "completed" | "error" | "aborted";
  stopReason?: string;
  errorMessage?: string;
};

export type AgentLifecycleNotification = {
  title: string;
  message: string;
  level: NotificationLevel;
};

export type AgentOutcomeEvent = "agent_start" | "agent_end" | "agent_settled";

export function updateAgentOutcome(
  current: AgentOutcome,
  event: AgentOutcomeEvent,
  payload?: unknown,
): AgentOutcome {
  if (event === "agent_start") return { kind: "completed" };
  if (event === "agent_end") return classifyAgentEnd(payload);
  return current;
}

export function classifyAgentEnd(payload: unknown): AgentOutcome {
  const message = getLastAssistantMessage(payload);
  if (!message) {
    return { kind: "error", errorMessage: "Agent 未返回最终结果" };
  }

  const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
  const errorMessage = typeof message.errorMessage === "string" && message.errorMessage.trim()
    ? message.errorMessage.trim()
    : undefined;

  if (stopReason === "aborted") {
    return { kind: "aborted", stopReason, errorMessage: errorMessage ?? "运行被中止" };
  }
  if (stopReason === "error") {
    return { kind: "error", stopReason, errorMessage: errorMessage ?? "发生未知错误" };
  }
  if (stopReason === "length") {
    return { kind: "error", stopReason, errorMessage: errorMessage ?? "输出达到长度上限" };
  }
  if (stopReason === "toolUse") {
    const toolError = extractLastToolError(payload);
    return toolError
      ? { kind: "error", stopReason, errorMessage: errorMessage ?? toolError }
      : { kind: "completed", stopReason };
  }
  if (stopReason === "stop") {
    return { kind: "completed", stopReason };
  }

  return {
    kind: "error",
    stopReason,
    errorMessage: errorMessage ?? `无法识别最终状态${stopReason ? `：${stopReason}` : ""}`,
  };
}

export function buildAgentLifecycleNotification(
  outcome: AgentOutcome,
  sessionName: string | undefined,
  recap?: string,
): AgentLifecycleNotification | null {
  const subject = sessionName ? `会话“${sessionName}”` : "任务";

  switch (outcome.kind) {
    case "error":
      return {
        title: "Pi — 任务异常终止",
        message: `${subject}异常终止：${outcome.errorMessage ?? "发生未知错误"}`,
        level: outcome.stopReason === "length" ? "warning" : "error",
      };
    case "aborted":
      return null;
    case "completed": {
      const summary = recap?.trim();
      if (summary) {
        return {
          title: sessionName ? `Pi — ${sessionName} 已完成` : "Pi — 任务完成",
          message: summary,
          level: "info",
        };
      }
      return {
        title: "Pi — 任务完成",
        message: `${subject}已正常完成。`,
        level: "info",
      };
    }
  }
}

function extractLastToolError(payload: unknown): string | null {
  const messages = isRecord(payload) ? payload.messages : undefined;
  if (!Array.isArray(messages)) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== "toolResult" || message.isError !== true) continue;
    if (typeof message.content === "string" && message.content.trim()) return message.content.trim();
    if (!Array.isArray(message.content)) continue;

    const text = message.content
      .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
      .map((block) => typeof block.text === "string" ? block.text.trim() : "")
      .filter(Boolean)
      .join(" ");
    if (text) return text;
  }
  return null;
}

function getLastAssistantMessage(payload: unknown): Record<string, unknown> | null {
  const messages = isRecord(payload) ? payload.messages : undefined;
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isRecord(message) && message.role === "assistant") return message;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
