import { join } from "node:path";
import { type JsonObject, readSettingsFile, updateSettingsFile } from "#src/config/settings-file";

export type AgentEnablementScope = "project" | "global";

export interface AgentEnablementState {
  enabled: boolean;
  source: "project" | "global" | "default";
  project?: boolean;
  global?: boolean;
}

/** Persistent, layered per-agent enablement settings. */
export class AgentEnablementSettings {
  private readonly agentDir: string;
  private readonly cwd: string;
  private globalEnabled: Record<string, boolean> = {};
  private projectEnabled: Record<string, boolean> = {};

  constructor({ agentDir, cwd }: { agentDir: string; cwd: string }) {
    this.agentDir = agentDir;
    this.cwd = cwd;
    this.reload();
  }

  reload(): void {
    this.globalEnabled = this.readScope("global");
    this.projectEnabled = this.readScope("project");
  }

  getState(name: string): AgentEnablementState {
    const project = getCaseInsensitive(this.projectEnabled, name);
    const global = getCaseInsensitive(this.globalEnabled, name);

    if (project !== undefined) {
      return {
        enabled: project,
        source: "project",
        project,
        ...(global === undefined ? {} : { global }),
      };
    }
    if (global !== undefined) {
      return { enabled: global, source: "global", global };
    }
    return { enabled: true, source: "default" };
  }

  getPath(scope: AgentEnablementScope): string {
    return scope === "global"
      ? join(this.agentDir, "subagents.local.json")
      : join(this.cwd, ".pi", "subagents.json");
  }

  set(scope: AgentEnablementScope, name: string, enabled: boolean | undefined): void {
    updateSettingsFile(this.getPath(scope), (current) => setAgentOverride(current, name, enabled));
    this.reload();
  }

  private readScope(scope: AgentEnablementScope): Record<string, boolean> {
    if (scope === "global") {
      return mergeEnablement(this.readLayer(join(this.agentDir, "subagents.json")), this.readLayer(this.getPath(scope)));
    }
    return this.readLayer(this.getPath(scope));
  }

  private readLayer(path: string): Record<string, boolean> {
    try {
      const file = readSettingsFile(path);
      return file ? agentEnabledFrom(file) : {};
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[pi-subagents] Ignoring malformed agent enablement at ${path}: ${reason}`);
      return {};
    }
  }
}

function agentEnabledFrom(file: JsonObject): Record<string, boolean> {
  if (!isJsonObject(file.agentEnabled)) return {};

  const enabled = Object.create(null) as Record<string, boolean>;
  for (const [name, value] of Object.entries(file.agentEnabled)) {
    if (typeof value === "boolean") enabled[name] = value;
  }
  return enabled;
}

function mergeEnablement(
  shared: Record<string, boolean>,
  local: Record<string, boolean>,
): Record<string, boolean> {
  const merged = Object.assign(Object.create(null), shared) as Record<string, boolean>;
  for (const [name, value] of Object.entries(local)) {
    removeCaseInsensitive(merged, name);
    merged[name] = value;
  }
  return merged;
}

function setAgentOverride(file: JsonObject, name: string, enabled: boolean | undefined): JsonObject {
  if (file.agentEnabled !== undefined && !isJsonObject(file.agentEnabled)) {
    throw new TypeError("agentEnabled must be a JSON object");
  }
  const agentEnabled = Object.assign(Object.create(null), file.agentEnabled) as JsonObject;
  removeCaseInsensitive(agentEnabled, name);
  if (enabled !== undefined) agentEnabled[name] = enabled;

  if (Object.keys(agentEnabled).length === 0) delete file.agentEnabled;
  else file.agentEnabled = agentEnabled;
  return file;
}

function removeCaseInsensitive(enabled: Record<string, unknown>, name: string): void {
  const normalizedName = name.toLowerCase();
  for (const existingName of Object.keys(enabled)) {
    if (existingName.toLowerCase() === normalizedName) delete enabled[existingName];
  }
}

function getCaseInsensitive(enabled: Record<string, boolean>, name: string): boolean | undefined {
  const normalizedName = name.toLowerCase();
  let result: boolean | undefined;
  for (const [existingName, value] of Object.entries(enabled)) {
    if (existingName.toLowerCase() === normalizedName) result = value;
  }
  return result;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
