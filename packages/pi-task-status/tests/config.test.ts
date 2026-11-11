import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("invalid config falls back to twenty updates", () => {
  assert.equal(parseMaxUpdates({ maxUpdatesPerTask: 0 }), 20);
  assert.equal(parseMaxUpdates({ maxUpdatesPerTask: 1001 }), 20);
  assert.equal(parseMaxUpdates({ maxUpdatesPerTask: 2.5 }), 20);
  assert.equal(parseMaxUpdates({}), 20);
  assert.equal(parseMaxUpdates({ maxUpdatesPerTask: 10 }), 10);
});

test("missing or malformed config files use the twenty-update default", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "task-status-config-default-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, CONFIG_FILE_NAME);
  assert.deepEqual(await loadTaskStatusConfig(configPath), { maxUpdatesPerTask: 20 });
  await writeFile(configPath, "{invalid", "utf8");
  assert.deepEqual(await loadTaskStatusConfig(configPath), { maxUpdatesPerTask: 20 });
});
