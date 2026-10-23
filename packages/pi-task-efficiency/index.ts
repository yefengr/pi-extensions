import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerTaskEfficiencyExtension } from "./extension/runtime.ts";

export default function taskEfficiencyExtension(pi: ExtensionAPI): void {
  registerTaskEfficiencyExtension(pi);
}
