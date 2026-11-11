import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SubagentLifecycleRecordV3 } from "#src/lifecycle/lifecycle-record";
import type { SubagentOutcome } from "#src/lifecycle/subagent-state";

export interface SavedInvocation {
  entryId: string;
  record: SubagentLifecycleRecordV3;
  version: 2 | 3;
}

export interface HistoryParent {
  id: string;
  file: string;
  entries: readonly unknown[];
}

export interface SavedAgentHistory {
  parent: HistoryParent;
  invocations: SavedInvocation[];
  latest: SubagentLifecycleRecordV3;
  outputFile?: string;
  issues: string[];
}

interface HistoryIO {
  readFile(path: string): string;
  listFiles(path: string): string[];
  realpath(path: string): string;
}

const DEFAULT_IO: HistoryIO = {
  readFile: (path) => readFileSync(path, "utf8"),
  listFiles: (path) => readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => join(path, entry.name)),
  realpath: realpathSync,
};
const OUTCOMES = new Set(["completed", "turn_limit", "timeout", "queue_timeout", "cancelled", "error"]);
const LEGACY_OUTCOMES: Record<string, SubagentOutcome> = {
  completed: "completed", steered: "completed", aborted: "cancelled", stopped: "cancelled", error: "error",
};

/** Read-only, branch-relative lookup. Never constructs or opens an SDK session. */
export class PersistedSubagentStore {
  private readonly getParent: () => HistoryParent | undefined;
  private readonly io: HistoryIO;
  constructor(getParent: () => HistoryParent | undefined, io: HistoryIO = DEFAULT_IO) {
    this.getParent = getParent;
    this.io = io;
  }

  get(id: string): SavedAgentHistory | undefined {
    const parent = this.getParent();
    if (!parent) return undefined;
    const entries = parent.entries.filter(isObject).filter((entry) => entry.type === "custom"
      && entry.customType === "subagents:record" && isObject(entry.data) && entry.data.id === id);
    if (entries.length === 0) return undefined;
    const issues: string[] = [];
    const invocations: SavedInvocation[] = [];
    for (const entry of entries) {
      try {
        invocations.push(parseSavedInvocation(entry));
      } catch (error) {
        issues.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (invocations.length === 0) throw new Error(issues.join("; "));
    invocations.sort((a, b) => a.record.invocationIndex - b.record.invocationIndex);
    const latest = invocations.at(-1)!.record;
    if (invocations.some(({ record }, index) => record.invocationIndex !== index + 1
      || record.type !== latest.type || record.sessionId !== latest.sessionId)) {
      issues.push("Conflicting or incomplete subagent invocation identity");
    }
    let outputFile: string | undefined;
    if (latest.sessionState === "created") {
      try {
        outputFile = this.locateChild(parent, latest);
        try {
          for (const line of this.io.readFile(outputFile).trimEnd().split(/\r?\n/)) JSON.parse(line);
        } catch {
          issues.push("Child transcript has an incomplete or malformed JSONL tail");
        }
      } catch (error) {
        issues.push(error instanceof Error ? error.message : String(error));
      }
    }
    return { parent, invocations, latest, outputFile, issues };
  }

  list(): SavedAgentHistory[] {
    const parent = this.getParent();
    if (!parent) return [];
    const ids = new Set(parent.entries.filter(isObject)
      .filter((entry) => entry.type === "custom" && entry.customType === "subagents:record")
      .map((entry) => isObject(entry.data) ? entry.data.id : undefined)
      .filter((id): id is string => typeof id === "string"));
    return [...ids].flatMap((id) => {
      try { const history = this.get(id); return history ? [history] : []; }
      catch { return []; }
    });
  }

  readTranscript(history: SavedAgentHistory): string {
    if (!history.outputFile) throw new Error("Subagent transcript is unavailable");
    return this.io.readFile(history.outputFile);
  }

  private locateChild(parent: HistoryParent, record: SubagentLifecycleRecordV3): string {
    if (!parent.file || !record.sessionId) throw new Error("Missing persisted parent or child identity");
    const directory = join(dirname(parent.file), basename(parent.file, ".jsonl"), "tasks");
    const root = this.io.realpath(directory);
    const candidatePaths = new Set<string>();
    if (record.outputFile) candidatePaths.add(resolve(record.outputFile));
    for (const path of this.io.listFiles(directory)) candidatePaths.add(resolve(path));
    const matching: string[] = [];
    for (const path of candidatePaths) {
      try {
        const canonical = this.io.realpath(path);
        const inside = relative(root, canonical);
        if (inside.startsWith("..") || isAbsolute(inside)) {
          if (record.outputFile && path === resolve(record.outputFile)) throw new Error("Child transcript path is outside its original directory");
          continue;
        }
        const header = JSON.parse(this.io.readFile(canonical).split(/\r?\n/, 1)[0] ?? "") as unknown;
        if (!isObject(header) || header.type !== "session" || header.id !== record.sessionId) continue;
        if (header.parentSession !== parent.id && header.parentSession !== parent.file) {
          throw new Error("Child transcript belongs to a different parent session");
        }
        if (!matching.includes(canonical)) matching.push(canonical);
      } catch (error) {
        if (error instanceof Error && (error.message.includes("different parent") || error.message.includes("outside its original"))) throw error;
      }
    }
    if (matching.length !== 1) throw new Error(matching.length ? "Multiple child transcripts match this session ID" : "Child transcript file is missing or invalid");
    return matching[0];
  }
}

/** v2 stays readable, but its normalized values never make it eligible for cold resume. */
export function parseSavedInvocation(entry: Record<string, unknown>): SavedInvocation {
  const value = entry.data;
  if (!isObject(value)) throw new Error("Invalid subagent lifecycle record");
  if (value.recordVersion !== 2 && value.recordVersion !== 3) {
    throw new Error(`Unsupported subagent lifecycle record version: ${String(value.recordVersion)}`);
  }
  const outcome = value.recordVersion === 2 ? LEGACY_OUTCOMES[String(value.status)] : value.outcome;
  const usage = value.invocationUsage;
  const lifetime = value.lifetimeUsage;
  if (!nonempty(entry.id) || !nonempty(value.id) || !nonempty(value.type) || typeof value.description !== "string"
    || typeof value.isBackground !== "boolean" || typeof outcome !== "string" || !OUTCOMES.has(outcome)
    || !validInvocation(value) || !validSession(value, outcome) || !validTiming(value)
    || !validUsage(usage) || !validUsage(lifetime) || !nonnegative(value.invocationToolUses)
    || !nonnegative(value.lifetimeToolUses) || value.lifetimeToolUses < value.invocationToolUses
    || lifetime.input < usage.input || lifetime.output < usage.output || lifetime.cacheWrite < usage.cacheWrite
    || (value.result !== undefined && typeof value.result !== "string")
    || (value.error !== undefined && typeof value.error !== "string")) {
    throw new Error("Invalid subagent lifecycle identity, timing or metrics");
  }
  if (value.recordVersion === 3 && (value.phase !== "terminal" || !nonnegative(value.invocationTurnCount)
    || !nonnegative(value.lifetimeTurnCount) || value.lifetimeTurnCount < value.invocationTurnCount
    || !positive(value.maxTurns) || !nonnegative(value.wrapUpTurns) || value.wrapUpTurns >= value.maxTurns
    || !positive(value.maxDurationSeconds))) throw new Error("Invalid subagent lifecycle v3 fields");
  return {
    entryId: entry.id,
    version: value.recordVersion,
    record: {
      ...value,
      phase: "terminal",
      outcome,
      // v2 lacks these fields; they are presentation defaults, never restoration evidence.
      invocationTurnCount: value.invocationTurnCount ?? 0,
      lifetimeTurnCount: value.lifetimeTurnCount ?? 0,
      maxTurns: value.maxTurns ?? 1,
      wrapUpTurns: value.wrapUpTurns ?? 0,
      maxDurationSeconds: value.maxDurationSeconds ?? 1,
    } as unknown as SubagentLifecycleRecordV3,
  };
}

function validInvocation(value: Record<string, unknown>): boolean {
  return positive(value.invocationIndex)
    && ((value.invocationKind === "fresh" && value.invocationIndex === 1)
      || (value.invocationKind === "resume" && value.invocationIndex > 1))
    && ((value.invocationSource === "tool" && nonempty(value.toolCallId))
      || (value.invocationSource === "service" && value.toolCallId === undefined));
}
function validSession(value: Record<string, unknown>, outcome: string): boolean {
  if (value.sessionState === "created") return nonempty(value.sessionId)
    && (value.outputFile === undefined || nonempty(value.outputFile));
  return value.sessionState === "not-created" && value.sessionId === undefined && value.outputFile === undefined
    && ["error", "cancelled", "queue_timeout"].includes(outcome);
}
function validTiming(value: Record<string, unknown>): boolean {
  return finite(value.startedAt) && finite(value.completedAt) && finite(value.durationMs)
    && value.completedAt >= value.startedAt && value.durationMs === value.completedAt - value.startedAt;
}
function validUsage(value: unknown): value is { input: number; output: number; cacheWrite: number; total: number } {
  return isObject(value) && finite(value.input) && finite(value.output) && finite(value.cacheWrite)
    && finite(value.total) && value.total === value.input + value.output + value.cacheWrite;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function nonnegative(value: unknown): value is number { return finite(value) && Number.isSafeInteger(value); }
function positive(value: unknown): value is number { return nonnegative(value) && value > 0; }
