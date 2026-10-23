import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NOTIFY_EVENTS, PI_LIFECYCLE_EVENTS, emitEvent } from "./event-contract.js";
import type {
  NotificationLevel,
  NotifyConfig,
  NotifyDispatchResult,
} from "./types.js";
import { isTerminalSupported, sendNativeNotification } from "./platforms/native.js";
import {
  buildAgentLifecycleNotification,
  updateAgentOutcome,
  type AgentOutcome,
} from "./agent-outcome.js";
import { summarizeLastMessage } from "./summarize.js";
import { loadConfig } from "./settings.js";

type NotifyRuntimeState = {
  sessionCtx: ExtensionContext | null;
  latestAgentOutcome: AgentOutcome;
};

const runtimeStates = new WeakMap<ExtensionAPI, NotifyRuntimeState>();

export function setSessionContext(pi: ExtensionAPI, ctx: ExtensionContext): void {
  getRuntimeState(pi).sessionCtx = ctx;
}

export function clearSessionContext(pi: ExtensionAPI): void {
  getRuntimeState(pi).sessionCtx = null;
}

export function registerEventListeners(pi: ExtensionAPI): void {
  const state = getRuntimeState(pi);

  pi.on(PI_LIFECYCLE_EVENTS.SESSION_SHUTDOWN, () => {
    const config = loadConfig();
    if (!config.enabled || !config.events.session_shutdown.enabled) return;
    void dispatchNotification(
      pi,
      "Pi — 会话结束",
      "Pi 会话即将结束",
      PI_LIFECYCLE_EVENTS.SESSION_SHUTDOWN,
      config,
    );
  });

  pi.on(PI_LIFECYCLE_EVENTS.AGENT_START, () => {
    state.latestAgentOutcome = updateAgentOutcome(
      state.latestAgentOutcome,
      PI_LIFECYCLE_EVENTS.AGENT_START,
    );
  });

  registerAgentNotification(pi, PI_LIFECYCLE_EVENTS.AGENT_END, state);
  registerAgentNotification(pi, PI_LIFECYCLE_EVENTS.AGENT_SETTLED, state);
}

export async function dispatchNotification(
  pi: ExtensionAPI,
  title: string,
  message: string,
  eventType: string,
  config: NotifyConfig,
  level: NotificationLevel = "info",
): Promise<NotifyDispatchResult> {
  if (!config.enabled) {
    return {
      status: "disabled",
      eventType,
      level,
    };
  }

  const result = await sendNativeNotification(title, message, level);
  const dispatchResult: NotifyDispatchResult = { ...result, eventType };
  if (result.status !== "sent") return dispatchResult;

  emitEvent(pi, NOTIFY_EVENTS.SENT, {
    eventType,
    platforms: ["native"],
    success: true,
    status: "sent",
    level: result.level,
    timeoutMs: result.timeoutMs,
    terminal: result.terminal,
    protocol: result.protocol,
    timestamp: new Date().toISOString(),
  });
  return dispatchResult;
}

function registerAgentNotification(
  pi: ExtensionAPI,
  eventKey: "agent_end" | "agent_settled",
  state: NotifyRuntimeState,
): void {
  const handler = (payload: unknown) => {
    state.latestAgentOutcome = updateAgentOutcome(
      state.latestAgentOutcome,
      eventKey,
      payload,
    );
    const outcome = state.latestAgentOutcome;

    const config = loadConfig();
    if (!config.enabled || !config.events[eventKey].enabled) return;
    // Avoid an unnecessary recap request when the terminal cannot receive it.
    if (!isTerminalSupported()) return;

    const lastText = eventKey === "agent_end"
      ? extractLastAssistantText(payload)
      : extractLastAssistantTextFromSession(state);
    sendAgentOutcomeNotification(pi, eventKey, outcome, lastText, config, state);
  };

  (pi as any).on(eventKey, handler);
}

function sendAgentOutcomeNotification(
  pi: ExtensionAPI,
  eventKey: "agent_end" | "agent_settled",
  outcome: AgentOutcome,
  lastText: string | null,
  config: NotifyConfig,
  state: NotifyRuntimeState,
): void {
  const sessionName = pi.getSessionName?.();
  const notification = buildAgentLifecycleNotification(outcome, sessionName);
  if (!notification) return;

  if (
    outcome.kind === "completed"
    && config.recap.enabled
    && config.recap.model
    && state.sessionCtx?.modelRegistry
    && lastText
  ) {
    const provider = extractProvider(config.recap.model);
    const modelId = extractModelId(config.recap.model);
    const model = state.sessionCtx.modelRegistry.find(provider, modelId);

    if (model) {
      state.sessionCtx.modelRegistry.getApiKeyAndHeaders(model)
        .then((apiKeyResult) => {
          const apiKey = apiKeyResult.ok
            ? (apiKeyResult as { apiKey?: string }).apiKey
            : undefined;
          if (!apiKey) return notification;
          return summarizeLastMessage(lastText, apiKey, model.baseUrl, model.api, modelId)
            .then((recap) => buildAgentLifecycleNotification(outcome, sessionName, recap));
        })
        .catch(() => notification)
        .then((recapNotification) => recapNotification
          ? dispatchNotification(
              pi,
              recapNotification.title,
              recapNotification.message,
              eventKey,
              config,
              recapNotification.level,
            )
          : undefined)
        .catch(() => undefined);
      return;
    }
  }

  void dispatchNotification(
    pi,
    notification.title,
    notification.message,
    eventKey,
    config,
    notification.level,
  );
}

function extractLastAssistantTextFromSession(state: NotifyRuntimeState): string | null {
  const entries = state.sessionCtx?.sessionManager.getEntries() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const text = extractAssistantText(entry.message);
    if (text) return text;
  }
  return null;
}

function extractLastAssistantText(payload: unknown): string | null {
  const messages = isRecord(payload) ? payload.messages : undefined;
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = extractAssistantText(messages[i]);
    if (text) return text;
  }
  return null;
}

function extractAssistantText(message: unknown): string | null {
  if (!isRecord(message) || message.role !== "assistant") return null;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return null;

  const parts = message.content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
    .map((block) => typeof block.text === "string" ? block.text : "")
    .filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : null;
}

function extractProvider(modelRef: string): string {
  const slashIndex = modelRef.indexOf("/");
  return slashIndex > 0 ? modelRef.slice(0, slashIndex) : modelRef;
}

function extractModelId(modelRef: string): string {
  const slashIndex = modelRef.indexOf("/");
  return slashIndex > 0 ? modelRef.slice(slashIndex + 1) : modelRef;
}

function getRuntimeState(pi: ExtensionAPI): NotifyRuntimeState {
  const existing = runtimeStates.get(pi);
  if (existing) return existing;

  const state: NotifyRuntimeState = {
    sessionCtx: null,
    latestAgentOutcome: { kind: "completed" },
  };
  runtimeStates.set(pi, state);
  return state;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
