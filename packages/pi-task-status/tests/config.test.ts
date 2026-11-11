import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CONFIG_FILE_NAME, loadTaskStatusConfig, parseMaxUpdates } from "../src/config.ts";

test("config uses the configured update limit", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "task-status-config-"));
  const configPath = path.join(directory, "task-status.json");
  await writeFile(configPath, JSON.stringify({ maxUpdatesPerTask: 25 }), "utf8");

  assert.deepEqual(await loadTaskStatusConfig(configPath), { maxUpdatesPerTask: 25 });
});

test("config file name matches the extension", () => {
  assert.equal(CONFIG_FILE_NAME, "task-status.json");
});

test("invalid config falls back to ten updates", async () => {
  assert.equal(parseMaxUpdates({ maxUpdatesPerTask: 0 }), 10);
  assert.equal(parseMaxUpdates({ maxUpdatesPerTask: 1001 }), 10);
  assert.equal(parseMaxUpdates({ maxUpdatesPerTask: 2.5 }), 10);
  assert.equal(parseMaxUpdates({}), 10);
});
