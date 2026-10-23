import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
  NotifyConfig,
  NotifyConfigUpdate,
  NotifyEventKey,
  RecapConfig,
} from "./types.js";

export const EVENT_KEYS: readonly NotifyEventKey[] = [
  "agent_end",
  "agent_settled",
  "session_shutdown",
];

const CONFIG_RELATIVE_PATH = join("config", "notify.json");

export const DEFAULT_CONFIG: NotifyConfig = {
  enabled: true,
  events: {
    agent_end: { enabled: false },
    agent_settled: { enabled: true },
    session_shutdown: { enabled: false },
  },
  recap: {
    enabled: false,
    model: null,
  },
};

export function resolveConfigPath(): string {
  const base = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(base, CONFIG_RELATIVE_PATH);
}

export function loadConfig(): NotifyConfig {
  const configPath = resolveConfigPath();
  if (!existsSync(configPath)) return cloneDefaultConfig();

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    return mergeWithDefaults(parsed);
  } catch {
    return cloneDefaultConfig();
  }
}

export function saveConfig(config: NotifyConfig): void {
  const configPath = resolveConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function updateConfig(partial: NotifyConfigUpdate): NotifyConfig {
  const current = loadConfig();
  const updated: NotifyConfig = {
    ...current,
    ...partial,
    events: partial.events ? { ...current.events, ...partial.events } : current.events,
    recap: partial.recap ? { ...current.recap, ...partial.recap } : current.recap,
  };
  saveConfig(updated);
  return updated;
}

export function cloneDefaultConfig(): NotifyConfig {
  return {
    enabled: DEFAULT_CONFIG.enabled,
    events: Object.fromEntries(
      Object.entries(DEFAULT_CONFIG.events).map(([key, value]) => [key, { ...value }]),
    ) as NotifyConfig["events"],
    recap: { ...DEFAULT_CONFIG.recap },
  };
}

function mergeWithDefaults(input: unknown): NotifyConfig {
  const loaded = isRecord(input) ? input : {};
  const loadedEvents = isRecord(loaded.events) ? loaded.events : {};
  const events = Object.fromEntries(EVENT_KEYS.map((key) => {
    const value = isRecord(loadedEvents[key]) ? loadedEvents[key] : {};
    return [key, { ...DEFAULT_CONFIG.events[key], enabled: value.enabled === true }];
  })) as NotifyConfig["events"];

  const loadedRecap = isRecord(loaded.recap) ? loaded.recap : {};
  const recap: RecapConfig = {
    enabled: loadedRecap.enabled === true,
    model: typeof loadedRecap.model === "string" && loadedRecap.model.trim()
      ? loadedRecap.model.trim()
      : null,
  };

  return {
    enabled: loaded.enabled !== false,
    events,
    recap,
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
