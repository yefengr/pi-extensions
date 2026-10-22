import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, resolveConfigPath, saveConfig, updateConfig } from "../../settings.ts";

function withTempAgentDir(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "agent-tools-notify-settings-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    run(directory);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("notification settings", () => {
  it("loads defaults from the new Pi config path", () => {
    withTempAgentDir((directory) => {
      const config = loadConfig();
      assert.equal(resolveConfigPath(), join(directory, "config", "notify.json"));
      assert.equal(config.enabled, true);
      assert.equal(config.events.agent_settled.enabled, true);
      assert.equal(config.events.agent_end.enabled, false);
      assert.equal(config.events.session_shutdown.enabled, false);
      assert.deepEqual(Object.keys(config.events), [
        "agent_end",
        "agent_settled",
        "session_shutdown",
      ]);
      assert.equal(config.recap.enabled, false);
    });
  });

  it("saves and partially updates config without dropping other event switches", () => {
    withTempAgentDir(() => {
      const config = loadConfig();
      saveConfig(config);
      const updated = updateConfig({
        enabled: false,
        events: { session_shutdown: { enabled: true } },
      });
      assert.equal(updated.enabled, false);
      assert.equal(updated.events.session_shutdown.enabled, true);
      assert.equal(updated.events.agent_settled.enabled, true);
      assert.deepEqual(loadConfig(), updated);
      assert.match(readFileSync(resolveConfigPath(), "utf8"), /"enabled": false/);
    });
  });

  it("normalizes malformed values and ignores unknown events", () => {
    withTempAgentDir(() => {
      const configPath = resolveConfigPath();
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify({
        enabled: false,
        events: {
          legacy_external_event: { enabled: true },
          agent_settled: { enabled: "yes" },
          unknown_event: { enabled: true },
        },
        recap: { enabled: true, model: " openai/gpt-5 " },
      }));

      const config = loadConfig();
      assert.equal(config.enabled, false);
      assert.equal(config.events.agent_settled.enabled, false);
      assert.equal("legacy_external_event" in config.events, false);
      assert.equal("unknown_event" in config.events, false);
      assert.equal(config.recap.enabled, true);
      assert.equal(config.recap.model, "openai/gpt-5");
    });
  });
});
