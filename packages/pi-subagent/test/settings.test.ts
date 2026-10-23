import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSettings,
  persistToastFor,
  SettingsManager,
  saveSettings,
} from "#src/settings";
import { captureWarn } from "#test/helpers/capture-warn";
import { createSettingsDirs, type SettingsDirs } from "#test/helpers/tmp-settings-dirs";

const DEFAULT_SNAPSHOT = {
  maxConcurrent: 4,
  maxTurns: 30,
  wrapUpTurns: 2,
  maxDurationSeconds: 1800,
  maxQueueWaitSeconds: 900,
  abortGraceSeconds: 5,
  consumedSessionRetentionMinutes: 10,
  unconsumedSessionRetentionMinutes: 720,
  abortAllOnInterrupt: true,
};

/**
 * Tests for persistent settings. Uses two tmp directories:
 * - `globalDir`: passed directly as agentDir. Simulates `~/.pi/agent/` — the global scope.
 * - `projectDir`: passed explicitly as cwd to load/save.
 *   Simulates the user's project root. Settings live at `<projectDir>/.pi/subagents.json`.
 */
describe("settings persistence", () => {
  let dirs: SettingsDirs;
  let globalDir: string;
  let projectDir: string;
  let globalFile: () => string;
  let projectFile: () => string;
  let writeGlobal: (obj: unknown) => void;
  let writeProject: (obj: unknown) => void;

  beforeEach(() => {
    dirs = createSettingsDirs("subagents.json");
    ({ globalDir, projectDir, globalFile, projectFile, writeGlobal, writeProject } = dirs);
  });

  afterEach(() => {
    dirs.dispose();
  });

  it("returns {} when both files are missing", () => {
    expect(loadSettings(globalDir, projectDir)).toEqual({});
  });

  it("returns {} when both files are malformed JSON", () => {
    writeFileSync(globalFile(), "not json {{");
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(projectFile(), "also not json");
    expect(loadSettings(globalDir, projectDir)).toEqual({});
  });

  it("loads from global when no project file", () => {
    writeGlobal({ maxConcurrent: 16, wrapUpTurns: 4 });
    expect(loadSettings(globalDir, projectDir)).toEqual({ maxConcurrent: 16, wrapUpTurns: 4 });
  });

  it("loads from project when no global file", () => {
    writeProject({ maxConcurrent: 8 });
    expect(loadSettings(globalDir, projectDir)).toEqual({ maxConcurrent: 8 });
  });

  it("merges global + project with project winning on conflicts", () => {
    writeGlobal({ maxConcurrent: 16, wrapUpTurns: 4 });
    writeProject({ maxConcurrent: 4, maxTurns: 50 });
    expect(loadSettings(globalDir, projectDir)).toEqual({
      maxConcurrent: 4, // project wins
      wrapUpTurns: 4, // from global
      maxTurns: 50, // from project only
    });
  });

  it("round-trips values: saveSettings then loadSettings", () => {
    const settings = {
      maxConcurrent: 7,
      maxTurns: 30,
      wrapUpTurns: 3,
      maxDurationSeconds: 1200,
      maxQueueWaitSeconds: 300,
      abortGraceSeconds: 10,
    };
    saveSettings(settings, projectDir);
    expect(loadSettings(globalDir, projectDir)).toEqual(settings);
  });

  it("saveSettings writes only to the project file; global is untouched", () => {
    writeGlobal({ maxConcurrent: 16 });
    saveSettings({ maxConcurrent: 2 }, projectDir);

    // Project file contains the new value
    expect(JSON.parse(readFileSync(projectFile(), "utf-8"))).toEqual({ maxConcurrent: 2 });
    // Global file unchanged
    expect(JSON.parse(readFileSync(globalFile(), "utf-8"))).toEqual({ maxConcurrent: 16 });
  });

  it("saveSettings creates <cwd>/.pi/ when missing", () => {
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
    saveSettings({ maxConcurrent: 4 }, projectDir);
    expect(existsSync(projectFile())).toBe(true);
  });

  it("ignores unknown extra fields on load (forward-compat)", () => {
    writeProject({ maxConcurrent: 2, futureField: "ignored" });
    const loaded = loadSettings(globalDir, projectDir);
    expect(loaded.maxConcurrent).toBe(2);
    // Unknown fields are stripped by the sanitizer — old versions won't persist garbage
    expect((loaded as Record<string, unknown>).futureField).toBeUndefined();
  });

  it("composes partial global + partial project correctly", () => {
    writeGlobal({ wrapUpTurns: 4 });
    writeProject({ maxConcurrent: 2 });
    expect(loadSettings(globalDir, projectDir)).toEqual({ wrapUpTurns: 4, maxConcurrent: 2 });
  });

  describe("sanitizer", () => {
    it("drops maxConcurrent < 1", () => {
      writeProject({ maxConcurrent: 0, wrapUpTurns: 1 });
      expect(loadSettings(globalDir, projectDir)).toEqual({ wrapUpTurns: 1 });
    });

    it("drops negative maxConcurrent", () => {
      writeProject({ maxConcurrent: -3 });
      expect(loadSettings(globalDir, projectDir)).toEqual({});
    });

    it("drops non-integer maxConcurrent (floats, NaN, strings)", () => {
      writeProject({ maxConcurrent: 3.5 });
      expect(loadSettings(globalDir, projectDir).maxConcurrent).toBeUndefined();
      writeProject({ maxConcurrent: "four" });
      expect(loadSettings(globalDir, projectDir).maxConcurrent).toBeUndefined();
      writeProject({ maxConcurrent: null });
      expect(loadSettings(globalDir, projectDir).maxConcurrent).toBeUndefined();
    });

    it("accepts maxTurns at 1 and at the ceiling (10000)", () => {
      writeProject({ maxTurns: 1 });
      expect(loadSettings(globalDir, projectDir).maxTurns).toBe(1);
      writeProject({ maxTurns: 10_000 });
      expect(loadSettings(globalDir, projectDir).maxTurns).toBe(10_000);
    });

    it("drops maxTurns below 1 — 0 is not unlimited any more", () => {
      writeProject({ maxTurns: 0 });
      expect(loadSettings(globalDir, projectDir)).toEqual({});
      writeProject({ maxTurns: -1 });
      expect(loadSettings(globalDir, projectDir)).toEqual({});
    });

    it("drops non-integer or above-ceiling maxTurns", () => {
      writeProject({ maxTurns: 10.5 });
      expect(loadSettings(globalDir, projectDir).maxTurns).toBeUndefined();
      writeProject({ maxTurns: 10_001 });
      expect(loadSettings(globalDir, projectDir).maxTurns).toBeUndefined();
    });

    it("accepts wrapUpTurns 0 and up to the ceiling (9999)", () => {
      writeProject({ wrapUpTurns: 0 });
      expect(loadSettings(globalDir, projectDir).wrapUpTurns).toBe(0);
      writeProject({ wrapUpTurns: 9_999 });
      expect(loadSettings(globalDir, projectDir).wrapUpTurns).toBe(9_999);
    });

    it("drops negative, non-integer, or above-ceiling wrapUpTurns", () => {
      writeProject({ wrapUpTurns: -1 });
      expect(loadSettings(globalDir, projectDir).wrapUpTurns).toBeUndefined();
      writeProject({ wrapUpTurns: 1.5 });
      expect(loadSettings(globalDir, projectDir).wrapUpTurns).toBeUndefined();
      writeProject({ wrapUpTurns: 10_000 });
      expect(loadSettings(globalDir, projectDir).wrapUpTurns).toBeUndefined();
    });

    it("accepts duration budgets within [1, 86400] seconds", () => {
      writeProject({
        maxDurationSeconds: 60,
        maxQueueWaitSeconds: 86_400,
        abortGraceSeconds: 3_600,
      });
      expect(loadSettings(globalDir, projectDir)).toEqual({
        maxDurationSeconds: 60,
        maxQueueWaitSeconds: 86_400,
        abortGraceSeconds: 3_600,
      });
    });

    it("drops duration budgets below 1, non-integer, or above their ceiling", () => {
      writeProject({ maxDurationSeconds: 0 });
      expect(loadSettings(globalDir, projectDir).maxDurationSeconds).toBeUndefined();
      writeProject({ maxDurationSeconds: 86_401 });
      expect(loadSettings(globalDir, projectDir).maxDurationSeconds).toBeUndefined();
      writeProject({ maxQueueWaitSeconds: 12.5 });
      expect(loadSettings(globalDir, projectDir).maxQueueWaitSeconds).toBeUndefined();
      writeProject({ abortGraceSeconds: 0 });
      expect(loadSettings(globalDir, projectDir).abortGraceSeconds).toBeUndefined();
      writeProject({ abortGraceSeconds: 3_601 });
      expect(loadSettings(globalDir, projectDir).abortGraceSeconds).toBeUndefined();
    });


    it("accepts retention windows within [1, 20160]", () => {
      writeProject({ consumedSessionRetentionMinutes: 15, unconsumedSessionRetentionMinutes: 1440 });
      expect(loadSettings(globalDir, projectDir)).toEqual({
        consumedSessionRetentionMinutes: 15,
        unconsumedSessionRetentionMinutes: 1440,
      });
    });

    it("drops retention windows < 1, non-integer, or above the ceiling", () => {
      writeProject({ consumedSessionRetentionMinutes: 0 });
      expect(loadSettings(globalDir, projectDir).consumedSessionRetentionMinutes).toBeUndefined();
      writeProject({ unconsumedSessionRetentionMinutes: 20_161 });
      expect(loadSettings(globalDir, projectDir).unconsumedSessionRetentionMinutes).toBeUndefined();
      writeProject({ consumedSessionRetentionMinutes: 12.5 });
      expect(loadSettings(globalDir, projectDir).consumedSessionRetentionMinutes).toBeUndefined();
    });

    it("returns {} when the JSON root is not an object (array, string, null)", () => {
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      writeFileSync(projectFile(), '["not", "an", "object"]');
      expect(loadSettings(globalDir, projectDir)).toEqual({});
      writeFileSync(projectFile(), '"just a string"');
      expect(loadSettings(globalDir, projectDir)).toEqual({});
      writeFileSync(projectFile(), "null");
      expect(loadSettings(globalDir, projectDir)).toEqual({});
    });

    it("keeps valid fields while dropping invalid siblings", () => {
      writeProject({
        maxConcurrent: 4, // ok
        maxTurns: -5, // dropped
        wrapUpTurns: 1, // ok
      });
      expect(loadSettings(globalDir, projectDir)).toEqual({ maxConcurrent: 4, wrapUpTurns: 1 });
    });

    it("drops absurdly large values (e.g. 1e6)", () => {
      writeProject({
        maxConcurrent: 1_000_000,
        maxTurns: 1_000_000,
        wrapUpTurns: 1_000_000,
        maxDurationSeconds: 1_000_000,
        maxQueueWaitSeconds: 1_000_000,
        abortGraceSeconds: 1_000_000,
      });
      expect(loadSettings(globalDir, projectDir)).toEqual({});
    });

    it("keeps abortAllOnInterrupt when it is a boolean", () => {
      writeProject({ abortAllOnInterrupt: false });
      expect(loadSettings(globalDir, projectDir)).toEqual({ abortAllOnInterrupt: false });
      writeProject({ abortAllOnInterrupt: true });
      expect(loadSettings(globalDir, projectDir)).toEqual({ abortAllOnInterrupt: true });
    });

    it("drops a non-boolean abortAllOnInterrupt", () => {
      writeProject({ abortAllOnInterrupt: "false", wrapUpTurns: 1 });
      expect(loadSettings(globalDir, projectDir)).toEqual({ wrapUpTurns: 1 });
      writeProject({ abortAllOnInterrupt: 0 });
      expect(loadSettings(globalDir, projectDir)).toEqual({});
      writeProject({ abortAllOnInterrupt: null });
      expect(loadSettings(globalDir, projectDir)).toEqual({});
    });

    describe("excludedExtensionPackages", () => {
      it("keeps string members, trimming and deduplicating them", () => {
        writeProject({
          excludedExtensionPackages: [
            " npm:@cortexkit/pi-magic-context ",
            "npm:@cortexkit/pi-magic-context",
            "npm:keep",
          ],
        });
        expect(loadSettings(globalDir, projectDir)).toEqual({
          excludedExtensionPackages: ["npm:@cortexkit/pi-magic-context", "npm:keep"],
        });
      });

      it("drops non-string and empty members", () => {
        writeProject({ excludedExtensionPackages: ["npm:keep", "", "   ", 42, null, {}] });
        expect(loadSettings(globalDir, projectDir)).toEqual({
          excludedExtensionPackages: ["npm:keep"],
        });
      });

      it("drops the key entirely when the value is not an array", () => {
        writeProject({ excludedExtensionPackages: "npm:@cortexkit/pi-magic-context" });
        expect(loadSettings(globalDir, projectDir)).toEqual({});
      });

      it("keeps an empty array as an empty array", () => {
        writeProject({ excludedExtensionPackages: [] });
        expect(loadSettings(globalDir, projectDir)).toEqual({ excludedExtensionPackages: [] });
      });
    });
  });

  describe("save result + corrupt-file warning", () => {
    it("saveSettings returns true on success", () => {
      expect(saveSettings({ maxConcurrent: 2 }, projectDir)).toBe(true);
      expect(JSON.parse(readFileSync(projectFile(), "utf-8"))).toEqual({ maxConcurrent: 2 });
    });

    it("saveSettings returns false when the target dir cannot be created", () => {
      // Place a regular file where the parent of the settings file would go —
      // mkdirSync + writeFileSync both fail with ENOTDIR / EEXIST.
      const filePosingAsCwd = join(tmpdir(), `pi-settings-notdir-${Date.now()}`);
      writeFileSync(filePosingAsCwd, "");
      try {
        expect(saveSettings({ maxConcurrent: 1 }, filePosingAsCwd)).toBe(false);
      } finally {
        rmSync(filePosingAsCwd, { force: true });
      }
    });

    it("warns to console.warn when an existing file is malformed", () => {
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      writeFileSync(projectFile(), "not valid json {{{");
      const warnings = captureWarn(() => {
        expect(loadSettings(globalDir, projectDir)).toEqual({});
      });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/Ignoring malformed settings/);
    });

    it("does NOT warn when a file is simply missing", () => {
      const warnings = captureWarn(() => {
        expect(loadSettings(globalDir, projectDir)).toEqual({});
      });
      expect(warnings).toEqual([]);
    });
  });

  describe("persistToastFor", () => {
    it("returns info-level toast with the plain message on success", () => {
      expect(persistToastFor("Max concurrency set to 7", true)).toEqual({
        message: "Max concurrency set to 7",
        level: "info",
      });
    });

    it("returns warning-level toast with session-only suffix on failure", () => {
      expect(persistToastFor("Max concurrency set to 7", false)).toEqual({
        message: "Max concurrency set to 7 (session only; failed to persist)",
        level: "warning",
      });
    });
  });
});

describe("SettingsManager", () => {
  describe("constructor defaults", () => {
    it("defaults to the global runtime budgets", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      expect(sm.maxTurns).toBe(30);
      expect(sm.wrapUpTurns).toBe(2);
      expect(sm.maxDurationSeconds).toBe(1800);
      expect(sm.maxQueueWaitSeconds).toBe(900);
      expect(sm.abortGraceSeconds).toBe(5);
    });

    it("defaults to maxConcurrent: 4", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      expect(sm.maxConcurrent).toBe(4);
    });

    it("defaults to consumedSessionRetentionMinutes: 10", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      expect(sm.consumedSessionRetentionMinutes).toBe(10);
    });

    it("defaults to unconsumedSessionRetentionMinutes: 720", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      expect(sm.unconsumedSessionRetentionMinutes).toBe(720);
    });

    it("defaults to abortAllOnInterrupt: true (ESC keeps its current blast radius)", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      expect(sm.abortAllOnInterrupt).toBe(true);
    });

    it("defaults to no excluded extension packages", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      expect(sm.excludedExtensionPackages).toEqual([]);
    });
  });

  describe("retention setter normalization", () => {
    it("stores a positive consumed window as-is", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      sm.consumedSessionRetentionMinutes = 30;
      expect(sm.consumedSessionRetentionMinutes).toBe(30);
    });

    it("clamps consumed window below 1 to 1", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      sm.consumedSessionRetentionMinutes = 0;
      expect(sm.consumedSessionRetentionMinutes).toBe(1);
    });

    it("clamps unconsumed window above the two-week ceiling to 20160", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      sm.unconsumedSessionRetentionMinutes = 99_999;
      expect(sm.unconsumedSessionRetentionMinutes).toBe(20_160);
    });
  });

  describe("maxTurns setter normalization", () => {
    it("stores a positive value as-is", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      sm.maxTurns = 10;
      expect(sm.maxTurns).toBe(10);
    });

    it("clamps 0 and negative values to 1 — there is no unlimited mode", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      sm.maxTurns = 0;
      expect(sm.maxTurns).toBe(1);
      sm.maxTurns = -5;
      expect(sm.maxTurns).toBe(1);
    });

    it("clamps values above the turn ceiling to 10000", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      sm.maxTurns = 99_999;
      expect(sm.maxTurns).toBe(10_000);
    });

    it("re-clamps wrapUpTurns below a lowered maxTurns", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      sm.wrapUpTurns = 5;
      sm.maxTurns = 3;
      expect(sm.wrapUpTurns).toBe(2);
      sm.maxTurns = 1;
      expect(sm.wrapUpTurns).toBe(0);
    });
  });

  describe("wrapUpTurns setter normalization", () => {
    it("stores a positive value as-is", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      sm.wrapUpTurns = 10;
      expect(sm.wrapUpTurns).toBe(10);
    });

    it("accepts 0 (stop at the hard limit)", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      sm.wrapUpTurns = 0;
      expect(sm.wrapUpTurns).toBe(0);
    });

    it("clamps negative values to 0", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      sm.wrapUpTurns = -3;
      expect(sm.wrapUpTurns).toBe(0);
    });

    it("clamps values to maxTurns - 1", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      sm.maxTurns = 5;
      sm.wrapUpTurns = 99;
      expect(sm.wrapUpTurns).toBe(4);
    });
  });

  describe("duration budget setter normalization", () => {
    it("stores positive seconds as-is", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      sm.maxDurationSeconds = 600;
      sm.maxQueueWaitSeconds = 120;
      sm.abortGraceSeconds = 30;
      expect(sm.maxDurationSeconds).toBe(600);
      expect(sm.maxQueueWaitSeconds).toBe(120);
      expect(sm.abortGraceSeconds).toBe(30);
    });

    it("clamps values below 1 to 1", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      sm.maxDurationSeconds = 0;
      sm.maxQueueWaitSeconds = -1;
      sm.abortGraceSeconds = 0;
      expect(sm.maxDurationSeconds).toBe(1);
      expect(sm.maxQueueWaitSeconds).toBe(1);
      expect(sm.abortGraceSeconds).toBe(1);
    });

    it("clamps values above the duration ceilings", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      sm.maxDurationSeconds = 999_999;
      sm.maxQueueWaitSeconds = 999_999;
      sm.abortGraceSeconds = 999_999;
      expect(sm.maxDurationSeconds).toBe(86_400);
      expect(sm.maxQueueWaitSeconds).toBe(86_400);
      expect(sm.abortGraceSeconds).toBe(3_600);
    });
  });

  describe("maxConcurrent setter normalization", () => {
    it("stores a positive value as-is", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      sm.maxConcurrent = 8;
      expect(sm.maxConcurrent).toBe(8);
    });

    it("clamps 0 to 1", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      sm.maxConcurrent = 0;
      expect(sm.maxConcurrent).toBe(1);
    });

    it("clamps negative values to 1", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      sm.maxConcurrent = -2;
      expect(sm.maxConcurrent).toBe(1);
    });
  });

  describe("load()", () => {
    let globalDir: string;
    let projectDir: string;

    beforeEach(() => {
      globalDir = mkdtempSync(join(tmpdir(), "pi-sm-global-"));
      projectDir = mkdtempSync(join(tmpdir(), "pi-sm-project-"));
    });

    afterEach(() => {
      rmSync(globalDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    });

    function writeProjectFile(obj: unknown) {
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      writeFileSync(join(projectDir, ".pi", "subagents.json"), JSON.stringify(obj));
    }

    it("applies merged settings from disk to in-memory values", () => {
      writeProjectFile({ wrapUpTurns: 4, maxConcurrent: 8 });
      const emit = vi.fn();
      const sm = new SettingsManager({ emit, cwd: projectDir, agentDir: globalDir });
      sm.load();
      expect(sm.wrapUpTurns).toBe(4);
      expect(sm.maxConcurrent).toBe(8);
      expect(sm.maxTurns).toBe(30);
    });

    it("applies maxTurns and clamps the loaded wrap-up window below it", () => {
      writeProjectFile({ maxTurns: 1, wrapUpTurns: 3 });
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: globalDir });
      sm.load();
      expect(sm.maxTurns).toBe(1);
      expect(sm.wrapUpTurns).toBe(0);
    });

    it("applies duration budgets from disk", () => {
      writeProjectFile({ maxDurationSeconds: 600, maxQueueWaitSeconds: 120, abortGraceSeconds: 30 });
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: globalDir });
      sm.load();
      expect(sm.maxDurationSeconds).toBe(600);
      expect(sm.maxQueueWaitSeconds).toBe(120);
      expect(sm.abortGraceSeconds).toBe(30);
    });


    it("applies retention windows from disk", () => {
      writeProjectFile({ consumedSessionRetentionMinutes: 20, unconsumedSessionRetentionMinutes: 60 });
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: globalDir });
      sm.load();
      expect(sm.consumedSessionRetentionMinutes).toBe(20);
      expect(sm.unconsumedSessionRetentionMinutes).toBe(60);
    });

    it("applies abortAllOnInterrupt: false from disk", () => {
      writeProjectFile({ abortAllOnInterrupt: false });
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: globalDir });
      sm.load();
      expect(sm.abortAllOnInterrupt).toBe(false);
    });

    it("leaves abortAllOnInterrupt at its default when the file omits it", () => {
      writeProjectFile({ wrapUpTurns: 4 });
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: globalDir });
      sm.load();
      expect(sm.abortAllOnInterrupt).toBe(true);
    });

    it("emits subagent:settings_loaded with merged settings", () => {
      writeProjectFile({ wrapUpTurns: 4 });
      const emit = vi.fn();
      const sm = new SettingsManager({ emit, cwd: projectDir, agentDir: globalDir });
      sm.load();
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith("subagent:settings_loaded", { settings: { wrapUpTurns: 4 } });
    });

    it("returns the loaded settings object", () => {
      writeProjectFile({ maxConcurrent: 6 });
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: globalDir });
      const result = sm.load();
      expect(result).toEqual({ maxConcurrent: 6 });
    });

    it("emits with empty settings when no files exist", () => {
      const emit = vi.fn();
      const sm = new SettingsManager({ emit, cwd: projectDir, agentDir: globalDir });
      sm.load();
      expect(emit).toHaveBeenCalledWith("subagent:settings_loaded", { settings: {} });
    });

    it("loads excluded extension package sources, and clears them when removed", () => {
      const settingsPath = join(projectDir, ".pi", "subagents.json");
      writeProjectFile({ excludedExtensionPackages: ["npm:@cortexkit/pi-magic-context"] });
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: globalDir });
      sm.load();
      expect(sm.excludedExtensionPackages).toEqual(["npm:@cortexkit/pi-magic-context"]);

      writeFileSync(settingsPath, JSON.stringify({}));
      sm.load();
      expect(sm.excludedExtensionPackages).toEqual([]);
    });
  });

  describe("snapshot()", () => {
    it("returns default values before any changes", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      expect(sm.snapshot()).toEqual(DEFAULT_SNAPSHOT);
    });

    it("reflects mutations across every budget", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      sm.maxTurns = 20;
      sm.wrapUpTurns = 3;
      sm.maxDurationSeconds = 600;
      sm.maxQueueWaitSeconds = 120;
      sm.abortGraceSeconds = 30;
      sm.maxConcurrent = 8;
      expect(sm.snapshot()).toEqual({
        ...DEFAULT_SNAPSHOT,
        maxTurns: 20,
        wrapUpTurns: 3,
        maxDurationSeconds: 600,
        maxQueueWaitSeconds: 120,
        abortGraceSeconds: 30,
        maxConcurrent: 8,
      });
    });

    it("reflects mutated retention windows", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      sm.consumedSessionRetentionMinutes = 30;
      sm.unconsumedSessionRetentionMinutes = 1440;
      expect(sm.snapshot()).toEqual({
        ...DEFAULT_SNAPSHOT,
        consumedSessionRetentionMinutes: 30,
        unconsumedSessionRetentionMinutes: 1440,
      });
    });

    it("reflects a flipped abortAllOnInterrupt", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      sm.toggleAbortAllOnInterrupt();
      expect(sm.snapshot()).toEqual({ ...DEFAULT_SNAPSHOT, abortAllOnInterrupt: false });
    });

    it("omits excludedExtensionPackages when none are configured", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" });
      expect(sm.snapshot()).toEqual(DEFAULT_SNAPSHOT);
    });
  });

  describe("saveAndNotify()", () => {
    let projectDir: string;

    beforeEach(() => {
      projectDir = mkdtempSync(join(tmpdir(), "pi-sm-save-"));
    });

    afterEach(() => {
      rmSync(projectDir, { recursive: true, force: true });
    });

    it("preserves a hand-edited excludedExtensionPackages across an unrelated edit", () => {
      // saveSettings rewrites the whole project file, so a key missing from
      // snapshot() is destroyed the next time any setting changes.
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      const settingsPath = join(projectDir, ".pi", "subagents.json");
      writeFileSync(
        settingsPath,
        JSON.stringify({ excludedExtensionPackages: ["npm:@cortexkit/pi-magic-context"] }),
      );
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: "/nonexistent" });
      sm.load();

      sm.applyWrapUpTurns(7);

      const written = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(written).toEqual({
        ...DEFAULT_SNAPSHOT,
        wrapUpTurns: 7,
        excludedExtensionPackages: ["npm:@cortexkit/pi-magic-context"],
      });
    });

    it("persists snapshot to disk and returns info toast on success", () => {
      const emit = vi.fn();
      const sm = new SettingsManager({ emit, cwd: projectDir, agentDir: "/nonexistent" });
      sm.maxConcurrent = 5;
      const toast = sm.saveAndNotify("Max concurrency set to 5");
      expect(toast).toEqual({ message: "Max concurrency set to 5", level: "info" });
      const written = JSON.parse(readFileSync(join(projectDir, ".pi", "subagents.json"), "utf-8"));
      expect(written).toEqual({ ...DEFAULT_SNAPSHOT, maxConcurrent: 5 });
    });

    it("emits subagent:settings_changed with persisted:true on success", () => {
      const emit = vi.fn();
      const sm = new SettingsManager({ emit, cwd: projectDir, agentDir: "/nonexistent" });
      sm.wrapUpTurns = 3;
      sm.saveAndNotify("Wrap-up turns set to 3");
      expect(emit).toHaveBeenCalledWith("subagent:settings_changed", {
        settings: { ...DEFAULT_SNAPSHOT, wrapUpTurns: 3 },
        persisted: true,
      });
    });

    it("returns warning toast when persist fails", () => {
      const filePosingAsCwd = join(tmpdir(), `pi-sm-notdir-${Date.now()}`);
      writeFileSync(filePosingAsCwd, "");
      try {
        const sm = new SettingsManager({ emit: vi.fn(), cwd: filePosingAsCwd, agentDir: "/nonexistent" });
        const toast = sm.saveAndNotify("Max concurrency set to 5");
        expect(toast).toEqual({
          message: "Max concurrency set to 5 (session only; failed to persist)",
          level: "warning",
        });
      } finally {
        rmSync(filePosingAsCwd, { force: true });
      }
    });

    it("emits subagent:settings_changed with persisted:false on failure", () => {
      const filePosingAsCwd = join(tmpdir(), `pi-sm-notdir2-${Date.now()}`);
      writeFileSync(filePosingAsCwd, "");
      const emit = vi.fn();
      try {
        const sm = new SettingsManager({ emit, cwd: filePosingAsCwd, agentDir: "/nonexistent" });
        sm.saveAndNotify("something");
        expect(emit).toHaveBeenCalledWith("subagent:settings_changed", {
          settings: DEFAULT_SNAPSHOT,
          persisted: false,
        });
      } finally {
        rmSync(filePosingAsCwd, { force: true });
      }
    });
  });

  describe("applyMaxConcurrent()", () => {
    let projectDir: string;

    beforeEach(() => {
      projectDir = mkdtempSync(join(tmpdir(), "pi-sm-apply-"));
    });

    afterEach(() => {
      rmSync(projectDir, { recursive: true, force: true });
    });

    it("sets maxConcurrent, calls callback, persists, and returns info toast", () => {
      const onChanged = vi.fn();
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: "/nonexistent", onMaxConcurrentChanged: onChanged });
      const toast = sm.applyMaxConcurrent(8);
      expect(sm.maxConcurrent).toBe(8);
      expect(onChanged).toHaveBeenCalledOnce();
      expect(toast).toEqual({ message: "Max concurrency set to 8", level: "info" });
      const written = JSON.parse(readFileSync(join(projectDir, ".pi", "subagents.json"), "utf-8"));
      expect(written.maxConcurrent).toBe(8);
    });

    it("normalizes 0 to 1 and reports the post-normalization value in the toast", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: "/nonexistent" });
      const toast = sm.applyMaxConcurrent(0);
      expect(sm.maxConcurrent).toBe(1);
      expect(toast.message).toBe("Max concurrency set to 1");
    });

    it("works without a callback — no throw, still persists and returns toast", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: "/nonexistent" });
      expect(() => sm.applyMaxConcurrent(6)).not.toThrow();
      expect(sm.maxConcurrent).toBe(6);
    });
  });

  describe("applyMaxTurns()", () => {
    let projectDir: string;

    beforeEach(() => {
      projectDir = mkdtempSync(join(tmpdir(), "pi-sm-apply-mt-"));
    });

    afterEach(() => {
      rmSync(projectDir, { recursive: true, force: true });
    });

    it("sets maxTurns, persists, and includes the value in the toast", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: "/nonexistent" });
      const toast = sm.applyMaxTurns(20);
      expect(sm.maxTurns).toBe(20);
      expect(toast).toEqual({ message: "Max turns set to 20", level: "info" });
      const written = JSON.parse(readFileSync(join(projectDir, ".pi", "subagents.json"), "utf-8"));
      expect(written.maxTurns).toBe(20);
    });

    it("normalizes 0 to 1 and reports the post-normalization value", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: "/nonexistent" });
      const toast = sm.applyMaxTurns(0);
      expect(sm.maxTurns).toBe(1);
      expect(toast.message).toBe("Max turns set to 1");
      expect(sm.wrapUpTurns).toBe(0);
    });

    it("does not call onMaxConcurrentChanged", () => {
      const onChanged = vi.fn();
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: "/nonexistent", onMaxConcurrentChanged: onChanged });
      sm.applyMaxTurns(12);
      expect(onChanged).not.toHaveBeenCalled();
    });
  });

  describe("applyWrapUpTurns()", () => {
    let projectDir: string;

    beforeEach(() => {
      projectDir = mkdtempSync(join(tmpdir(), "pi-sm-apply-wt-"));
    });

    afterEach(() => {
      rmSync(projectDir, { recursive: true, force: true });
    });

    it("sets wrapUpTurns, persists, and reports the post-normalization value", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: "/nonexistent" });
      const toast = sm.applyWrapUpTurns(3);
      expect(sm.wrapUpTurns).toBe(3);
      expect(toast).toEqual({ message: "Wrap-up turns set to 3", level: "info" });
      const written = JSON.parse(readFileSync(join(projectDir, ".pi", "subagents.json"), "utf-8"));
      expect(written.wrapUpTurns).toBe(3);
    });

    it("accepts 0 and reports it", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: "/nonexistent" });
      const toast = sm.applyWrapUpTurns(0);
      expect(sm.wrapUpTurns).toBe(0);
      expect(toast.message).toBe("Wrap-up turns set to 0");
    });

    it("clamps to maxTurns - 1 and reports the clamped value", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: "/nonexistent" });
      sm.maxTurns = 5;
      const toast = sm.applyWrapUpTurns(50);
      expect(sm.wrapUpTurns).toBe(4);
      expect(toast.message).toBe("Wrap-up turns set to 4");
    });
  });

  describe("applyMaxDurationSeconds() / applyMaxQueueWaitSeconds() / applyAbortGraceSeconds()", () => {
    let projectDir: string;

    beforeEach(() => {
      projectDir = mkdtempSync(join(tmpdir(), "pi-sm-apply-dur-"));
    });

    afterEach(() => {
      rmSync(projectDir, { recursive: true, force: true });
    });

    it("sets the run-duration budget, persists, and reports the post-normalization value", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: "/nonexistent" });
      const toast = sm.applyMaxDurationSeconds(600);
      expect(sm.maxDurationSeconds).toBe(600);
      expect(toast).toEqual({ message: "Max duration set to 600 s", level: "info" });
      const written = JSON.parse(readFileSync(join(projectDir, ".pi", "subagents.json"), "utf-8"));
      expect(written.maxDurationSeconds).toBe(600);
    });

    it("normalizes 0 to 1 and reports it", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: "/nonexistent" });
      const toast = sm.applyMaxDurationSeconds(0);
      expect(sm.maxDurationSeconds).toBe(1);
      expect(toast.message).toBe("Max duration set to 1 s");
    });

    it("sets the queue-wait budget, persists, and reports the post-normalization value", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: "/nonexistent" });
      const toast = sm.applyMaxQueueWaitSeconds(120);
      expect(sm.maxQueueWaitSeconds).toBe(120);
      expect(toast).toEqual({ message: "Max queue wait set to 120 s", level: "info" });
      const written = JSON.parse(readFileSync(join(projectDir, ".pi", "subagents.json"), "utf-8"));
      expect(written.maxQueueWaitSeconds).toBe(120);
    });

    it("sets the abort grace period, persists, and reports the post-normalization value", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: "/nonexistent" });
      const toast = sm.applyAbortGraceSeconds(30);
      expect(sm.abortGraceSeconds).toBe(30);
      expect(toast).toEqual({ message: "Abort grace set to 30 s", level: "info" });
      const written = JSON.parse(readFileSync(join(projectDir, ".pi", "subagents.json"), "utf-8"));
      expect(written.abortGraceSeconds).toBe(30);
    });

    it("does not call onMaxConcurrentChanged", () => {
      const onChanged = vi.fn();
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: "/nonexistent", onMaxConcurrentChanged: onChanged });
      sm.applyMaxDurationSeconds(600);
      sm.applyMaxQueueWaitSeconds(120);
      sm.applyAbortGraceSeconds(30);
      expect(onChanged).not.toHaveBeenCalled();
    });
  });

  describe("applyConsumedSessionRetentionMinutes() / applyUnconsumedSessionRetentionMinutes()", () => {
    let projectDir: string;

    beforeEach(() => {
      projectDir = mkdtempSync(join(tmpdir(), "pi-sm-apply-ret-"));
    });

    afterEach(() => {
      rmSync(projectDir, { recursive: true, force: true });
    });

    it("sets the consumed window, persists, and reports the post-normalization value", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: "/nonexistent" });
      const toast = sm.applyConsumedSessionRetentionMinutes(30);
      expect(sm.consumedSessionRetentionMinutes).toBe(30);
      expect(toast).toEqual({ message: "Consumed-session retention set to 30 min", level: "info" });
      const written = JSON.parse(readFileSync(join(projectDir, ".pi", "subagents.json"), "utf-8"));
      expect(written.consumedSessionRetentionMinutes).toBe(30);
    });

    it("normalizes 0 to 1 for the consumed window and reports it", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: "/nonexistent" });
      const toast = sm.applyConsumedSessionRetentionMinutes(0);
      expect(sm.consumedSessionRetentionMinutes).toBe(1);
      expect(toast.message).toBe("Consumed-session retention set to 1 min");
    });

    it("sets the unconsumed window, persists, and reports the post-normalization value", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: "/nonexistent" });
      const toast = sm.applyUnconsumedSessionRetentionMinutes(1440);
      expect(sm.unconsumedSessionRetentionMinutes).toBe(1440);
      expect(toast).toEqual({ message: "Unconsumed-session retention set to 1440 min", level: "info" });
      const written = JSON.parse(readFileSync(join(projectDir, ".pi", "subagents.json"), "utf-8"));
      expect(written.unconsumedSessionRetentionMinutes).toBe(1440);
    });

    it("does not call onMaxConcurrentChanged", () => {
      const onChanged = vi.fn();
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: "/nonexistent", onMaxConcurrentChanged: onChanged });
      sm.applyConsumedSessionRetentionMinutes(30);
      sm.applyUnconsumedSessionRetentionMinutes(1440);
      expect(onChanged).not.toHaveBeenCalled();
    });
  });

  describe("toggleAbortAllOnInterrupt()", () => {
    let projectDir: string;

    beforeEach(() => {
      projectDir = mkdtempSync(join(tmpdir(), "pi-sm-toggle-"));
    });

    afterEach(() => {
      rmSync(projectDir, { recursive: true, force: true });
    });

    it("flips the policy off, persists it, and reports the new state", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: "/nonexistent" });
      const toast = sm.toggleAbortAllOnInterrupt();
      expect(sm.abortAllOnInterrupt).toBe(false);
      expect(toast).toEqual({ message: "Abort all subagents on ESC: off", level: "info" });
      const written = JSON.parse(readFileSync(join(projectDir, ".pi", "subagents.json"), "utf-8"));
      expect(written.abortAllOnInterrupt).toBe(false);
    });

    it("flips the policy back on", () => {
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: "/nonexistent" });
      sm.toggleAbortAllOnInterrupt();
      const toast = sm.toggleAbortAllOnInterrupt();
      expect(sm.abortAllOnInterrupt).toBe(true);
      expect(toast).toEqual({ message: "Abort all subagents on ESC: on", level: "info" });
    });

    it("emits subagent:settings_changed carrying the flipped value", () => {
      const emit = vi.fn();
      const sm = new SettingsManager({ emit, cwd: projectDir, agentDir: "/nonexistent" });
      sm.toggleAbortAllOnInterrupt();
      expect(emit).toHaveBeenCalledWith("subagent:settings_changed", {
        settings: { ...DEFAULT_SNAPSHOT, abortAllOnInterrupt: false },
        persisted: true,
      });
    });

    it("keeps the in-memory flip and warns when the write fails", () => {
      const filePosingAsCwd = join(tmpdir(), `pi-sm-notdir-toggle-${Date.now()}`);
      writeFileSync(filePosingAsCwd, "");
      try {
        const sm = new SettingsManager({ emit: vi.fn(), cwd: filePosingAsCwd, agentDir: "/nonexistent" });
        const toast = sm.toggleAbortAllOnInterrupt();
        expect(sm.abortAllOnInterrupt).toBe(false);
        expect(toast).toEqual({
          message: "Abort all subagents on ESC: off (session only; failed to persist)",
          level: "warning",
        });
      } finally {
        rmSync(filePosingAsCwd, { force: true });
      }
    });

    it("does not call onMaxConcurrentChanged", () => {
      const onChanged = vi.fn();
      const sm = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: "/nonexistent", onMaxConcurrentChanged: onChanged });
      sm.toggleAbortAllOnInterrupt();
      expect(onChanged).not.toHaveBeenCalled();
    });
  });

  describe("constructor onMaxConcurrentChanged callback", () => {
    it("constructs without callback without throwing", () => {
      expect(() => new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent" })).not.toThrow();
    });

    it("constructs with callback without throwing", () => {
      expect(
        () => new SettingsManager({ emit: vi.fn(), cwd: "/tmp", agentDir: "/nonexistent", onMaxConcurrentChanged: vi.fn() }),
      ).not.toThrow();
    });
  });
});

describe("saveSettings durable key preservation", () => {
  let dirs: SettingsDirs;

  beforeEach(() => {
    dirs = createSettingsDirs("subagents.json");
  });

  afterEach(() => {
    dirs.dispose();
  });

  it("preserves agentEnabled and unknown project fields while saving the snapshot", () => {
    dirs.writeProject({
      maxConcurrent: 1,
      agentEnabled: { worker: false },
      futureField: { keep: true },
    });

    expect(saveSettings({ maxConcurrent: 8 }, dirs.projectDir)).toBe(true);
    expect(JSON.parse(readFileSync(dirs.projectFile(), "utf-8"))).toEqual({
      maxConcurrent: 8,
      agentEnabled: { worker: false },
      futureField: { keep: true },
    });
  });

  it("does not materialize global agentEnabled into the project file", () => {
    dirs.writeGlobal({ agentEnabled: { worker: false }, maxConcurrent: 16 });

    expect(saveSettings({ maxConcurrent: 8 }, dirs.projectDir)).toBe(true);
    expect(JSON.parse(readFileSync(dirs.projectFile(), "utf-8"))).toEqual({ maxConcurrent: 8 });
  });
});
