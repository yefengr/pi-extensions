import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  NOTIFY_EVENTS,
  NOTIFY_MODULE_NAME,
  NOTIFY_TOOL_NAME,
  emitEvent,
  getPackageVersion,
} from "./event-contract.js";
import { registerNotifyTools } from "./tools.js";
import { registerNotifyCommands } from "./commands.js";
import {
  registerEventListeners,
  setSessionContext,
  clearSessionContext,
} from "./events.js";
const VERSION = getPackageVersion(fileURLToPath(new URL("../", import.meta.url)));

export default function (pi: ExtensionAPI): void {
  registerNotifyTools(pi);
  registerNotifyCommands(pi);
  registerEventListeners(pi);

  pi.on("session_start", async (_event, ctx) => {
    setSessionContext(pi, ctx);
    emitEvent(pi, NOTIFY_EVENTS.MODULE_READY, {
      name: NOTIFY_MODULE_NAME,
      version: VERSION,
      commands: ["notify:settings", "notify:recap-model", "notify:test"],
      tools: [NOTIFY_TOOL_NAME],
    });
  });

  pi.on("session_shutdown", async () => {
    clearSessionContext(pi);
  });
}
