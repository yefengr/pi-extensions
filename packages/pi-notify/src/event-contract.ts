import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Events emitted by the local notification extension. */
export const NOTIFY_EVENTS = {
  MODULE_READY: "notify:module-ready",
  SENT: "notify:sent",
} as const;

export const PI_LIFECYCLE_EVENTS = {
  AGENT_START: "agent_start",
  AGENT_END: "agent_end",
  AGENT_SETTLED: "agent_settled",
  SESSION_SHUTDOWN: "session_shutdown",
} as const;

export const NOTIFY_MODULE_NAME = "pi-notify" as const;
export const NOTIFY_TOOL_NAME = "notify_user" as const;

export function emitEvent(
  pi: { events: { emit: (name: string, payload: unknown) => void } },
  eventName: string,
  payload: unknown,
): boolean {
  try {
    pi.events.emit(eventName, payload);
    return true;
  } catch {
    return false;
  }
}

export function getPackageVersion(packageDir: string): string {
  try {
    const raw = readFileSync(join(packageDir, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.3.3";
  } catch {
    return "0.3.3";
  }
}
