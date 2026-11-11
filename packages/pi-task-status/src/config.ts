import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DEFAULT_MAX_UPDATES, type TaskStatusConfig } from "./types.ts";

export const CONFIG_FILE_NAME = "task-status.json";
const MIN_MAX_UPDATES = 1;
const MAX_MAX_UPDATES = 1000;

export async function loadTaskStatusConfig(
  configPath = defaultConfigPath(),
): Promise<TaskStatusConfig> {
  try {
    const content = await readFile(configPath, "utf8");
    const parsed: unknown = JSON.parse(content);
    return {
      maxUpdatesPerTask: parseMaxUpdates(parsed),
    };
  } catch {
    return { maxUpdatesPerTask: DEFAULT_MAX_UPDATES };
  }
}

function defaultConfigPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
  return path.join(agentDir, CONFIG_FILE_NAME);
}

export function parseMaxUpdates(value: unknown): number {
  if (!value || typeof value !== "object") return DEFAULT_MAX_UPDATES;
  const candidate = (value as { maxUpdatesPerTask?: unknown }).maxUpdatesPerTask;
  if (
    typeof candidate !== "number" ||
    !Number.isInteger(candidate) ||
    candidate < MIN_MAX_UPDATES ||
    candidate > MAX_MAX_UPDATES
  ) {
    return DEFAULT_MAX_UPDATES;
  }
  return candidate;
}
