import type { NotificationLevel, NotifyResult } from "../types.js";
import { sendTerminalNotification } from "./terminal.js";

export { detectTerminal, isTerminalSupported } from "./terminal.js";

/** Send a notification through the current terminal's native protocol. */
export async function sendNativeNotification(
  title: string,
  message: string,
  level: NotificationLevel = "info",
): Promise<NotifyResult> {
  return sendTerminalNotification(title, message, process.stdout, process.env, level);
}
