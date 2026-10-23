// Persistence for pi-subagent operational settings.
// - Shared global: ~/.pi/agent/subagents.json (agentDir injected at construction) — managed by agent-tools
// - Personal global agent overrides: ~/.pi/agent/subagents.local.json — managed by /subagent:agents
// - Project: <cwd>/.pi/subagents.json — written by /agents → Settings; overrides global on load

import { join } from "node:path";
import { clampWrapUpTurns } from "#src/config/resource-limits";
import { updateSettingsFile } from "#src/config/settings-file";
import { type LayeredSettingsSource, loadLayeredSettings } from "#src/layered-settings";

export interface SubagentsSettings {
  maxConcurrent?: number;
  /** Global hard turn budget: every spawn is capped by this value. */
  maxTurns?: number;
  /** Global wrap-up window in turns, reserved before the hard stop; kept below maxTurns. */
  wrapUpTurns?: number;
  /** Global wall-clock budget for one subagent run, in seconds. */
  maxDurationSeconds?: number;
  /** Global budget for time an agent may wait in the background queue, in seconds. */
  maxQueueWaitSeconds?: number;
  /** Grace period after an abort request before waiters and the concurrency slot are released. */
  abortGraceSeconds?: number;
  /** Minutes a consumed agent's session is retained after its last relevance event. */
  consumedSessionRetentionMinutes?: number;
  /** Minutes an unconsumed agent's session is retained (safety cap). */
  unconsumedSessionRetentionMinutes?: number;
  /**
   * When false, a parent interrupt (ESC) leaves background and queued subagents
   * running. Foreground agents hold the parent's run signal directly, so they
   * abort on ESC either way.
   */
  abortAllOnInterrupt?: boolean;
  /**
   * Pi package sources whose extensions child sessions must not load, matched
   * against Pi's configured source string exactly (e.g. `npm:@scope/pkg`).
   * The package's skills, prompts, and themes stay available to children.
   */
  excludedExtensionPackages?: string[];
}

/**
 * The persisted form of the in-memory settings values.
 * `saveSettings` updates these values in the project file while preserving
 * keys owned by other configuration consumers.
 */
export interface SettingsSnapshot {
  maxConcurrent: number;
  maxTurns: number;
  wrapUpTurns: number;
  maxDurationSeconds: number;
  maxQueueWaitSeconds: number;
  abortGraceSeconds: number;
  consumedSessionRetentionMinutes: number;
  unconsumedSessionRetentionMinutes: number;
  abortAllOnInterrupt: boolean;
  /**
   * Present only when non-empty, so files that never set it gain no noise.
   * It must round-trip: the key has no `/subagent:settings` affordance, so a
   * hand-edited value would otherwise be erased by any unrelated setting change.
   */
  excludedExtensionPackages?: string[];
}

/** Emit callback — a subset of `pi.events.emit` to keep helpers testable. */
export type SettingsEmit = (event: string, payload: unknown) => void;

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_TURNS = 30;
const DEFAULT_WRAP_UP_TURNS = 2;
const DEFAULT_MAX_DURATION_SECONDS = 1800;
const DEFAULT_MAX_QUEUE_WAIT_SECONDS = 900;
const DEFAULT_ABORT_GRACE_SECONDS = 5;
const DEFAULT_CONSUMED_RETENTION_MINUTES = 10;
const DEFAULT_UNCONSUMED_RETENTION_MINUTES = 720;
const DEFAULT_ABORT_ALL_ON_INTERRUPT = true;

/**
 * Owns all in-memory settings values and their load/save/persist cycle.
 * Replaces the scattered free-function + SettingsAppliers callback pattern.
 */
export class SettingsManager {
  private _maxConcurrent: number = DEFAULT_MAX_CONCURRENT;
  private _maxTurns: number = DEFAULT_MAX_TURNS;
  private _wrapUpTurns: number = DEFAULT_WRAP_UP_TURNS;
  private _maxDurationSeconds: number = DEFAULT_MAX_DURATION_SECONDS;
  private _maxQueueWaitSeconds: number = DEFAULT_MAX_QUEUE_WAIT_SECONDS;
  private _abortGraceSeconds: number = DEFAULT_ABORT_GRACE_SECONDS;
  private _consumedSessionRetentionMinutes: number = DEFAULT_CONSUMED_RETENTION_MINUTES;
  private _unconsumedSessionRetentionMinutes: number = DEFAULT_UNCONSUMED_RETENTION_MINUTES;
  private _abortAllOnInterrupt: boolean = DEFAULT_ABORT_ALL_ON_INTERRUPT;
  private _excludedExtensionPackages: string[] = [];

  private readonly emit: SettingsEmit;
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly onMaxConcurrentChanged: (() => void) | undefined;

  constructor(deps: { emit: SettingsEmit; cwd: string; agentDir: string; onMaxConcurrentChanged?: () => void }) {
    this.emit = deps.emit;
    this.cwd = deps.cwd;
    this.agentDir = deps.agentDir;
    this.onMaxConcurrentChanged = deps.onMaxConcurrentChanged;
  }

  // ── maxConcurrent: minimum 1 ──

  get maxConcurrent(): number {
    return this._maxConcurrent;
  }

  set maxConcurrent(n: number) {
    this._maxConcurrent = Math.max(1, n);
  }

  // ── maxTurns: positive integer ≥ 1; lowering it re-clamps wrapUpTurns ──

  get maxTurns(): number {
    return this._maxTurns;
  }

  set maxTurns(n: number) {
    this._maxTurns = clampMin(n, MAX_TURNS_CEILING);
    this._wrapUpTurns = clampWrapUpTurns(this._wrapUpTurns, this._maxTurns);
  }

  // ── wrapUpTurns: 0 allowed; always kept below maxTurns ──

  get wrapUpTurns(): number {
    return this._wrapUpTurns;
  }

  set wrapUpTurns(n: number) {
    this._wrapUpTurns = clampWrapUpTurns(n, this._maxTurns);
  }

  // ── duration budgets: seconds, minimum 1 ──

  get maxDurationSeconds(): number {
    return this._maxDurationSeconds;
  }

  set maxDurationSeconds(n: number) {
    this._maxDurationSeconds = clampMin(n, MAX_DURATION_SECONDS_CEILING);
  }

  get maxQueueWaitSeconds(): number {
    return this._maxQueueWaitSeconds;
  }

  set maxQueueWaitSeconds(n: number) {
    this._maxQueueWaitSeconds = clampMin(n, MAX_QUEUE_WAIT_SECONDS_CEILING);
  }

  get abortGraceSeconds(): number {
    return this._abortGraceSeconds;
  }

  set abortGraceSeconds(n: number) {
    this._abortGraceSeconds = clampMin(n, ABORT_GRACE_SECONDS_CEILING);
  }

  // ── retention windows: clamped to [1, RETENTION_MINUTES_CEILING] minutes ──

  get consumedSessionRetentionMinutes(): number {
    return this._consumedSessionRetentionMinutes;
  }

  set consumedSessionRetentionMinutes(n: number) {
    this._consumedSessionRetentionMinutes = clampRetentionMinutes(n);
  }

  get unconsumedSessionRetentionMinutes(): number {
    return this._unconsumedSessionRetentionMinutes;
  }

  set unconsumedSessionRetentionMinutes(n: number) {
    this._unconsumedSessionRetentionMinutes = clampRetentionMinutes(n);
  }

  // ── abortAllOnInterrupt: flipped via toggleAbortAllOnInterrupt(); no normalization ──

  get abortAllOnInterrupt(): boolean {
    return this._abortAllOnInterrupt;
  }

  // ── excludedExtensionPackages: hand-edited only; no /subagent:settings affordance ──

  get excludedExtensionPackages(): readonly string[] {
    return this._excludedExtensionPackages;
  }

  // ── Lifecycle methods ──

  /**
   * Load merged settings (global + project), apply to in-memory values,
   * and emit the `subagent:settings_loaded` lifecycle event.
   * Returns the raw loaded settings object.
   */
  load(): SubagentsSettings {
    const settings = loadSettings(this.agentDir, this.cwd);
    if (typeof settings.maxConcurrent === "number") this.maxConcurrent = settings.maxConcurrent;
    // maxTurns before wrapUpTurns: the turn budget clamps the wrap-up window.
    if (typeof settings.maxTurns === "number") this.maxTurns = settings.maxTurns;
    if (typeof settings.wrapUpTurns === "number") this.wrapUpTurns = settings.wrapUpTurns;
    if (typeof settings.maxDurationSeconds === "number") this.maxDurationSeconds = settings.maxDurationSeconds;
    if (typeof settings.maxQueueWaitSeconds === "number") this.maxQueueWaitSeconds = settings.maxQueueWaitSeconds;
    if (typeof settings.abortGraceSeconds === "number") this.abortGraceSeconds = settings.abortGraceSeconds;
    if (typeof settings.consumedSessionRetentionMinutes === "number")
      this.consumedSessionRetentionMinutes = settings.consumedSessionRetentionMinutes;
    if (typeof settings.unconsumedSessionRetentionMinutes === "number")
      this.unconsumedSessionRetentionMinutes = settings.unconsumedSessionRetentionMinutes;
    if (typeof settings.abortAllOnInterrupt === "boolean")
      this._abortAllOnInterrupt = settings.abortAllOnInterrupt;
    // Assigned unconditionally: removing the key from disk must clear the value.
    this._excludedExtensionPackages = [...(settings.excludedExtensionPackages ?? [])];
    this.emit("subagent:settings_loaded", { settings });
    return settings;
  }

  /** Snapshot current in-memory values for persistence. */
  snapshot(): SettingsSnapshot {
    const snapshot: SettingsSnapshot = {
      maxConcurrent: this._maxConcurrent,
      maxTurns: this._maxTurns,
      wrapUpTurns: this._wrapUpTurns,
      maxDurationSeconds: this._maxDurationSeconds,
      maxQueueWaitSeconds: this._maxQueueWaitSeconds,
      abortGraceSeconds: this._abortGraceSeconds,
      consumedSessionRetentionMinutes: this._consumedSessionRetentionMinutes,
      unconsumedSessionRetentionMinutes: this._unconsumedSessionRetentionMinutes,
      abortAllOnInterrupt: this._abortAllOnInterrupt,
    };
    if (this._excludedExtensionPackages.length > 0) {
      snapshot.excludedExtensionPackages = [...this._excludedExtensionPackages];
    }
    return snapshot;
  }

  /**
   * Set maxConcurrent, notify interested parties, persist, and return the toast.
   * Owns the full consequence chain so callers just say what they want.
   */
  applyMaxConcurrent(n: number): { message: string; level: "info" | "warning" } {
    this.maxConcurrent = n; // setter normalizes: max(1, n)
    this.onMaxConcurrentChanged?.();
    return this.saveAndNotify(`Max concurrency set to ${this.maxConcurrent}`);
  }

  /** Set the global turn budget, persist, and return the toast. */
  applyMaxTurns(n: number): { message: string; level: "info" | "warning" } {
    this.maxTurns = n; // setter normalizes: clamp [1, ceiling]
    return this.saveAndNotify(`Max turns set to ${this.maxTurns}`);
  }

  /** Set the global wrap-up window (turns), persist, and return the toast. */
  applyWrapUpTurns(n: number): { message: string; level: "info" | "warning" } {
    this.wrapUpTurns = n; // setter normalizes: clamp [0, maxTurns - 1]
    return this.saveAndNotify(`Wrap-up turns set to ${this.wrapUpTurns}`);
  }

  /** Set the global run-duration budget (seconds), persist, and return the toast. */
  applyMaxDurationSeconds(n: number): { message: string; level: "info" | "warning" } {
    this.maxDurationSeconds = n; // setter normalizes: clamp [1, ceiling]
    return this.saveAndNotify(`Max duration set to ${this.maxDurationSeconds} s`);
  }

  /** Set the global queue-wait budget (seconds), persist, and return the toast. */
  applyMaxQueueWaitSeconds(n: number): { message: string; level: "info" | "warning" } {
    this.maxQueueWaitSeconds = n; // setter normalizes: clamp [1, ceiling]
    return this.saveAndNotify(`Max queue wait set to ${this.maxQueueWaitSeconds} s`);
  }

  /** Set the abort grace period (seconds), persist, and return the toast. */
  applyAbortGraceSeconds(n: number): { message: string; level: "info" | "warning" } {
    this.abortGraceSeconds = n; // setter normalizes: clamp [1, ceiling]
    return this.saveAndNotify(`Abort grace set to ${this.abortGraceSeconds} s`);
  }

  /** Set the consumed-session retention window (minutes), persist, and return the toast. */
  applyConsumedSessionRetentionMinutes(n: number): { message: string; level: "info" | "warning" } {
    this.consumedSessionRetentionMinutes = n; // setter normalizes: clamp [1, ceiling]
    return this.saveAndNotify(`Consumed-session retention set to ${this.consumedSessionRetentionMinutes} min`);
  }

  /** Set the unconsumed-session retention window (minutes), persist, and return the toast. */
  applyUnconsumedSessionRetentionMinutes(n: number): { message: string; level: "info" | "warning" } {
    this.unconsumedSessionRetentionMinutes = n; // setter normalizes: clamp [1, ceiling]
    return this.saveAndNotify(`Unconsumed-session retention set to ${this.unconsumedSessionRetentionMinutes} min`);
  }

  /**
   * Flip whether a parent interrupt (ESC) aborts every subagent, persist, and
   * return the toast. The manager owns the negation so callers just say "flip it".
   */
  toggleAbortAllOnInterrupt(): { message: string; level: "info" | "warning" } {
    this._abortAllOnInterrupt = !this._abortAllOnInterrupt;
    return this.saveAndNotify(
      `Abort all subagents on ESC: ${this._abortAllOnInterrupt ? "on" : "off"}`,
    );
  }

  /**
   * Persist the current snapshot, emit `subagent:settings_changed`,
   * and return the toast the UI should display.
   */
  saveAndNotify(successMsg: string): { message: string; level: "info" | "warning" } {
    const snap = this.snapshot();
    const persisted = saveSettings(snap, this.cwd);
    this.emit("subagent:settings_changed", { settings: snap, persisted });
    return persistToastFor(successMsg, persisted);
  }
}

// Sanity ceilings — prevent hand-edited configs from asking for values that
// make no operational sense (e.g. 1e6 concurrent subagents). Permissive enough
// that any realistic power-user setting passes through.
const MAX_CONCURRENT_CEILING = 1024;
const MAX_TURNS_CEILING = 10_000;
// wrapUpTurns must stay below maxTurns, so its ceiling is one turn lower.
const WRAP_UP_TURNS_CEILING = MAX_TURNS_CEILING - 1;
const ONE_DAY_SECONDS = 60 * 60 * 24;
const MAX_DURATION_SECONDS_CEILING = ONE_DAY_SECONDS;
const MAX_QUEUE_WAIT_SECONDS_CEILING = ONE_DAY_SECONDS;
const ABORT_GRACE_SECONDS_CEILING = 60 * 60;
// Retention windows: 1 minute floor, two-week ceiling (60 * 24 * 14).
const RETENTION_MINUTES_CEILING = 20_160;

/** Clamp a budget to [1, ceiling]. */
function clampMin(n: number, ceiling: number): number {
  return Math.min(ceiling, Math.max(1, n));
}

/** Clamp a retention window to [1, RETENTION_MINUTES_CEILING] minutes. */
function clampRetentionMinutes(n: number): number {
  return Math.min(RETENTION_MINUTES_CEILING, Math.max(1, n));
}

/** True when a value is an integer minute count within the accepted retention range. */
function isRetentionMinutes(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= 1 && (n as number) <= RETENTION_MINUTES_CEILING;
}

/** True when a value is an integer within [min, max]. */
function isIntInRange(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

/** Drop fields that don't match the expected shape. Silent — garbage becomes absent. */
function sanitize(raw: unknown): SubagentsSettings {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: SubagentsSettings = {};
  if (isIntInRange(r.maxConcurrent, 1, MAX_CONCURRENT_CEILING)) {
    out.maxConcurrent = r.maxConcurrent;
  }
  if (isIntInRange(r.maxTurns, 1, MAX_TURNS_CEILING)) {
    out.maxTurns = r.maxTurns;
  }
  if (isIntInRange(r.wrapUpTurns, 0, WRAP_UP_TURNS_CEILING)) {
    out.wrapUpTurns = r.wrapUpTurns;
  }
  if (isIntInRange(r.maxDurationSeconds, 1, MAX_DURATION_SECONDS_CEILING)) {
    out.maxDurationSeconds = r.maxDurationSeconds;
  }
  if (isIntInRange(r.maxQueueWaitSeconds, 1, MAX_QUEUE_WAIT_SECONDS_CEILING)) {
    out.maxQueueWaitSeconds = r.maxQueueWaitSeconds;
  }
  if (isIntInRange(r.abortGraceSeconds, 1, ABORT_GRACE_SECONDS_CEILING)) {
    out.abortGraceSeconds = r.abortGraceSeconds;
  }
  if (isRetentionMinutes(r.consumedSessionRetentionMinutes)) {
    out.consumedSessionRetentionMinutes = r.consumedSessionRetentionMinutes;
  }
  if (isRetentionMinutes(r.unconsumedSessionRetentionMinutes)) {
    out.unconsumedSessionRetentionMinutes = r.unconsumedSessionRetentionMinutes;
  }
  if (typeof r.abortAllOnInterrupt === "boolean") {
    out.abortAllOnInterrupt = r.abortAllOnInterrupt;
  }
  if (Array.isArray(r.excludedExtensionPackages)) {
    const sources = r.excludedExtensionPackages
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    out.excludedExtensionPackages = [...new Set(sources)];
  }
  return out;
}

function projectPath(cwd: string): string {
  return join(cwd, ".pi", "subagents.json");
}

/** Load merged settings: global provides defaults, project overrides. */
export function loadSettings(agentDir: string, cwd: string): SubagentsSettings {
  return loadLayeredSettings({
    agentDir,
    cwd,
    filename: "subagents.json",
    sanitize,
    warnLabel: "pi-subagent",
  } satisfies LayeredSettingsSource<SubagentsSettings>);
}

/**
 * Update project-local settings. Global is never touched from code.
 * Returns `true` on success, `false` if the locked atomic update fails so the
 * caller can surface a warning — persistence isn't fatal but isn't silent.
 */
export function saveSettings(s: SubagentsSettings, cwd: string = process.cwd()): boolean {
  const path = projectPath(cwd);
  try {
    updateSettingsFile(path, (current) => ({ ...current, ...withoutUndefined(s) }));
    return true;
  } catch {
    return false;
  }
}

function withoutUndefined(settings: SubagentsSettings): Record<string, unknown> {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined));
}

/**
 * Format the user-facing toast for a settings mutation. Pure function —
 * routes the success/failure of `saveSettings` into the right message + level
 * so the UI layer (index.ts) stays a thin wire between input and notification.
 */
export function persistToastFor(
  successMsg: string,
  persisted: boolean,
): { message: string; level: "info" | "warning" } {
  return persisted
    ? { message: successMsg, level: "info" }
    : { message: `${successMsg} (session only; failed to persist)`, level: "warning" };
}
