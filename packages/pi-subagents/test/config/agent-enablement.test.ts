import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentEnablementSettings,
  type AgentEnablementState,
} from "#src/config/agent-enablement";
import { captureWarn } from "#test/helpers/capture-warn";
import { createSettingsDirs, type SettingsDirs } from "#test/helpers/tmp-settings-dirs";

describe("AgentEnablementSettings", () => {
  let dirs: SettingsDirs;
  let settings: AgentEnablementSettings;
  const localFile = () => join(dirs.globalDir, "subagents.local.json");

  beforeEach(() => {
    dirs = createSettingsDirs("subagents.json");
    settings = new AgentEnablementSettings({ agentDir: dirs.globalDir, cwd: dirs.projectDir });
  });

  afterEach(() => {
    dirs.dispose();
  });

  it("defaults every agent to enabled and exposes both settings paths", () => {
    expect(settings.getState("worker")).toEqual({ enabled: true, source: "default" });
    expect(settings.getPath("global")).toBe(localFile());
    expect(settings.getPath("project")).toBe(dirs.projectFile());
  });

  it("merges shared and local global layers, with local and project overrides", () => {
    dirs.writeGlobal({ agentEnabled: { Worker: false, reviewer: false } });
    writeFileSync(localFile(), JSON.stringify({ agentEnabled: { WORKER: true, reviewer: true, localOnly: false } }));
    dirs.writeProject({ agentEnabled: { worker: false, planner: false } });
    settings.reload();

    expect(settings.getState("WORKER")).toEqual({
      enabled: false,
      source: "project",
      project: false,
      global: true,
    } satisfies AgentEnablementState);
    expect(settings.getState("reviewer")).toEqual({ enabled: true, source: "global", global: true });
    expect(settings.getState("localOnly")).toEqual({ enabled: false, source: "global", global: false });
    expect(settings.getState("planner")).toEqual({ enabled: false, source: "project", project: false });
  });

  it("writes only the selected layer, preserves unrelated data, and canonicalizes the name", () => {
    dirs.writeProject({
      futureField: { keep: true },
      agentEnabled: { WORKER: true, reviewer: false },
    });

    settings.set("project", "Worker", false);

    expect(JSON.parse(readFileSync(dirs.projectFile(), "utf-8"))).toEqual({
      futureField: { keep: true },
      agentEnabled: { reviewer: false, Worker: false },
    });
    expect(existsSync(dirs.globalFile())).toBe(false);
    expect(existsSync(localFile())).toBe(false);
  });

  it("writes global overrides to local, preserves shared data, and creates a missing local file", () => {
    dirs.writeGlobal({ futureField: { keep: true }, agentEnabled: { worker: false } });

    settings.set("global", "Worker", true);

    expect(JSON.parse(readFileSync(dirs.globalFile(), "utf-8"))).toEqual({
      futureField: { keep: true },
      agentEnabled: { worker: false },
    });
    expect(JSON.parse(readFileSync(localFile(), "utf-8"))).toEqual({ agentEnabled: { Worker: true } });
    expect(settings.getState("worker")).toEqual({ enabled: true, source: "global", global: true });
  });

  it("treats __proto__ as a valid agent name without changing the map prototype", () => {
    writeFileSync(dirs.globalFile(), '{"agentEnabled":{"__proto__":false}}');
    settings.reload();

    expect(settings.getState("__proto__")).toEqual({ enabled: false, source: "global", global: false });
    settings.set("global", "__proto__", true);
    const sharedAgentEnabled = JSON.parse(readFileSync(dirs.globalFile(), "utf-8"))
      .agentEnabled as Record<string, boolean>;
    const localAgentEnabled = JSON.parse(readFileSync(localFile(), "utf-8"))
      .agentEnabled as Record<string, boolean>;
    expect(Object.entries(sharedAgentEnabled).find(([name]) => name === "__proto__")?.[1]).toBe(false);
    expect(Object.entries(localAgentEnabled).find(([name]) => name === "__proto__")?.[1]).toBe(true);
  });

  it("rejects a non-object agentEnabled value without overwriting it", () => {
    dirs.writeProject({ agentEnabled: ["invalid"], futureField: "keep" });
    const before = readFileSync(dirs.projectFile(), "utf-8");

    expect(() => settings.set("project", "worker", false)).toThrow(/agentEnabled must be a JSON object/);
    expect(readFileSync(dirs.projectFile(), "utf-8")).toBe(before);
  });

  it("removes only one scope override when passed undefined and restores inheritance", () => {
    dirs.writeGlobal({ agentEnabled: { worker: false } });
    dirs.writeProject({ agentEnabled: { WORKER: true, reviewer: false } });
    settings.reload();

    settings.set("project", "worker", undefined);

    expect(settings.getState("worker")).toEqual({ enabled: false, source: "global", global: false });
    expect(JSON.parse(readFileSync(dirs.projectFile(), "utf-8"))).toEqual({
      agentEnabled: { reviewer: false },
    });
  });

  it("restores global inheritance by removing only the local override", () => {
    dirs.writeGlobal({ futureField: { keep: true }, agentEnabled: { worker: false } });
    writeFileSync(
      localFile(),
      JSON.stringify({ localField: { keep: true }, agentEnabled: { WORKER: true, reviewer: false } }),
    );
    settings.reload();

    settings.set("global", "worker", undefined);

    expect(settings.getState("worker")).toEqual({ enabled: false, source: "global", global: false });
    expect(settings.getState("reviewer")).toEqual({ enabled: false, source: "global", global: false });
    expect(JSON.parse(readFileSync(dirs.globalFile(), "utf-8"))).toEqual({
      futureField: { keep: true },
      agentEnabled: { worker: false },
    });
    expect(JSON.parse(readFileSync(localFile(), "utf-8"))).toEqual({
      localField: { keep: true },
      agentEnabled: { reviewer: false },
    });
  });

  it("reloads external changes instead of retaining stale state", () => {
    dirs.writeGlobal({ agentEnabled: { worker: false } });
    settings.reload();
    expect(settings.getState("worker")).toEqual({ enabled: false, source: "global", global: false });

    dirs.writeProject({ agentEnabled: { worker: true } });
    settings.reload();
    expect(settings.getState("worker")).toEqual({
      enabled: true,
      source: "project",
      project: true,
      global: false,
    });
  });

  it("warns and ignores a malformed layer, while preserving another valid layer", () => {
    writeFileSync(dirs.globalFile(), "not json");
    dirs.writeProject({ agentEnabled: { worker: false } });

    const warnings = captureWarn(() => {
      settings.reload();
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Ignoring malformed agent enablement/);
    expect(settings.getState("worker")).toEqual({ enabled: false, source: "project", project: false });
  });

  it("rejects malformed local writes without changing state or the original file", () => {
    writeFileSync(localFile(), "not json");
    const before = readFileSync(localFile(), "utf-8");

    expect(() => settings.set("global", "worker", false)).toThrow();
    expect(readFileSync(localFile(), "utf-8")).toBe(before);
    expect(settings.getState("worker")).toEqual({ enabled: true, source: "default" });
  });

  it("does not retain a session-only state when its write loses the lock", () => {
    dirs.writeGlobal({ agentEnabled: { worker: false } });
    settings.reload();
    writeFileSync(`${localFile()}.lock`, "other writer");

    expect(() => settings.set("global", "worker", true)).toThrow();
    expect(settings.getState("worker")).toEqual({ enabled: false, source: "global", global: false });
    expect(existsSync(`${localFile()}.lock`)).toBe(true);
  });
});
