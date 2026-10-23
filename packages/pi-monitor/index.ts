import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMonitor } from "./src/extension.ts";

export default function monitor(pi: ExtensionAPI): void {
  registerMonitor(pi);
}
