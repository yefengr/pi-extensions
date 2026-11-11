import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CONFIG_FILE_NAME, loadTaskStatusConfig, parseMaxUpdates } from "../src/config.ts";

test("config uses the configured update limit", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "task-status-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "task-status.json");
  await writeFile(configPath, JSON.stringify({ maxUpdatesPerTask: 25 }), "utf8");

  assert.deepEqual(await loadTaskStatusConfig(configPath), { maxUpdatesPerTask: 25 });
});

test("default config honors a native agent directory containing Chinese, spaces and #", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "任务状态 config #-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = directory;
  await writeFile(path.join(directory, CONFIG_FILE_NAME), JSON.stringify({ maxUpdatesPerTask: 35 }), "utf8");
  assert.deepEqual(await loadTaskStatusConfig(), { maxUpdatesPerTask: 35 });
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
