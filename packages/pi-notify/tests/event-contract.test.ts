import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NOTIFY_EVENTS,
  NOTIFY_MODULE_NAME,
  NOTIFY_TOOL_NAME,
  PI_LIFECYCLE_EVENTS,
  getPackageVersion,
} from "../src/event-contract.ts";

describe("notification event contract", () => {
  it("uses only the agent-tools namespace for emitted events", () => {
    assert.deepEqual(NOTIFY_EVENTS, {
      MODULE_READY: "notify:module-ready",
      SENT: "notify:sent",
    });
    assert.equal(NOTIFY_MODULE_NAME, "pi-notify");
    assert.equal(NOTIFY_TOOL_NAME, "notify_user");
  });

  it("declares only Pi-native lifecycle hooks", () => {
    assert.deepEqual(PI_LIFECYCLE_EVENTS, {
      AGENT_START: "agent_start",
      AGENT_END: "agent_end",
      AGENT_SETTLED: "agent_settled",
      SESSION_SHUTDOWN: "session_shutdown",
    });
  });

  it("uses the current package version as the missing-metadata fallback", () => {
    assert.equal(getPackageVersion("/path/that/does/not/exist"), "0.3.3");
  });

  it("keeps the package root entry and version metadata at the package root", () => {
    const packageRoot = fileURLToPath(new URL("../", import.meta.url));
    const rootEntry = readFileSync(join(packageRoot, "index.ts"), "utf8");
    const packageJson = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { version: string };

    assert.equal(rootEntry.trim(), 'export { default } from "./src/index.ts";');
    assert.equal(getPackageVersion(packageRoot), packageJson.version);
  });
});
