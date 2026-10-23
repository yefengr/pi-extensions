import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NOTIFY_EVENTS,
  NOTIFY_MODULE_NAME,
  NOTIFY_TOOL_NAME,
  PI_LIFECYCLE_EVENTS,
  getPackageVersion,
} from "../../event-contract.ts";

describe("notification event contract", () => {
  it("uses only the agent-tools namespace for emitted events", () => {
    assert.deepEqual(NOTIFY_EVENTS, {
      MODULE_READY: "pi-notify:module-ready",
      SENT: "pi-notify:sent",
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
    assert.equal(getPackageVersion("/path/that/does/not/exist"), "0.3.1");
  });
});
