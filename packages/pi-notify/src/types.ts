/** Notification status returned by local terminal delivery. */
export type NotifyStatus = "sent" | "unsupported" | "disabled" | "failed";

/** Semantic notification level, independent from terminal presentation support. */
export type NotificationLevel = "info" | "warning" | "error";

/** Supported terminal protocols and their identifying terminal. */
export type TerminalProtocol = "osc9" | "osc777" | "osc99";
export type TerminalName = "ghostty" | "wezterm" | "kitty" | "iterm2";

export interface TerminalDetection {
  name: TerminalName;
  protocol: TerminalProtocol;
  signal: string;
}

/** Pi lifecycle events supported by the local notification extension. */
export type NotifyEventKey = "agent_end" | "agent_settled" | "session_shutdown";

/** Event switch stored in the private notification config. */
export interface EventNotifyConfig {
  enabled: boolean;
}

/** Recap summarization settings. */
export interface RecapConfig {
  enabled: boolean;
  model: string | null;
}

/** Complete private notification configuration. */
export interface NotifyConfig {
  enabled: boolean;
  events: Record<NotifyEventKey, EventNotifyConfig>;
  recap: RecapConfig;
}

/** Partial configuration accepted by programmatic updates. */
export type NotifyConfigUpdate = Omit<Partial<NotifyConfig>, "events" | "recap"> & {
  events?: Partial<Record<NotifyEventKey, EventNotifyConfig>>;
  recap?: Partial<RecapConfig>;
};

/** Parameters for the local notify_user agent tool. */
export interface NotifyUserParams {
  message: string;
  title?: string;
  level?: NotificationLevel;
}

/** Result of one local terminal notification attempt. */
export interface NotifyResult {
  status: NotifyStatus;
  level: NotificationLevel;
  timeoutMs?: number;
  terminal?: TerminalName;
  protocol?: TerminalProtocol;
  error?: string;
}

/** Notification dispatch result, including the triggering event when present. */
export interface NotifyDispatchResult extends NotifyResult {
  eventType?: string;
}
