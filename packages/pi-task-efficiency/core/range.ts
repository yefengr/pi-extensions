import { deepFreeze } from "./freeze.ts";
import {
  type InternalTurn,
  type TaskRangeSelection,
  TaskRangeError,
  type TaskTurnStatus,
  type ValidatedTaskRange,
} from "./report-types.ts";
import type { SnapshotEntry, SourceSnapshot } from "./types.ts";

const TERMINAL_REASONS = new Set(["stop", "length", "error", "aborted"]);
const MAX_DATE_TIME_VALUE = 8_640_000_000_000_000;

export function validateTaskRange(
  snapshot: SourceSnapshot,
  selection: TaskRangeSelection,
): ValidatedTaskRange {
  const startIndex = snapshot.activeBranch.findIndex((entry) => entry.id === selection.startEntryId);
  const endIndex = snapshot.activeBranch.findIndex((entry) => entry.id === selection.endEntryId);
  if (startIndex < 0 || endIndex < 0 || startIndex > endIndex) {
    throw new TaskRangeError("invalid-range", "task range endpoints must be ordered entries on the active branch");
  }
  if (!isUserEntry(snapshot.activeBranch[startIndex])) {
    throw new TaskRangeError("range-start-not-user", "task range must start at a user entry");
  }

  const entries = snapshot.activeBranch.slice(startIndex, endIndex + 1);
  const turns = deriveTurns(entries, startIndex);
  const finalTurn = turns.at(-1);
  if (finalTurn === undefined || finalTurn.status === "superseded") {
    throw new TaskRangeError("range-final-superseded", "the final selected turn cannot be superseded");
  }
  if (!finalTurn.settled || finalTurn.terminalEntryId !== selection.endEntryId) {
    throw new TaskRangeError("range-final-incomplete", "task range must end on a terminal assistant response");
  }

  return deepFreeze({
    source: {
      sessionId: snapshot.sessionId,
      digest: snapshot.digest,
      activeLeafId: snapshot.activeLeafId,
    },
    startEntryId: selection.startEntryId,
    endEntryId: selection.endEntryId,
    startIndex,
    endIndex,
    entryCount: entries.length,
    turns: turns.map(toPublicTurn),
  });
}

export function selectedRangeEntries(
  snapshot: SourceSnapshot,
  range: ValidatedTaskRange,
): readonly SnapshotEntry[] {
  const revalidated = validateTaskRange(snapshot, range);
  if (range.source.sessionId !== revalidated.source.sessionId
    || range.source.digest !== revalidated.source.digest
    || range.source.activeLeafId !== revalidated.source.activeLeafId
    || range.startIndex !== revalidated.startIndex
    || range.endIndex !== revalidated.endIndex) {
    throw new TaskRangeError("invalid-range", "validated range does not belong to this source snapshot");
  }
  return Object.freeze(snapshot.activeBranch.slice(revalidated.startIndex, revalidated.endIndex + 1));
}

export function deriveTurns(entries: readonly SnapshotEntry[], offset = 0): readonly InternalTurn[] {
  const turns: InternalTurn[] = [];
  let current: { user: SnapshotEntry; startIndex: number; entries: SnapshotEntry[] } | undefined;
  for (const [index, entry] of entries.entries()) {
    if (isUserEntry(entry)) {
      if (current !== undefined) turns.push(finishTurn(current, offset + index - 1, true));
      current = { user: entry, startIndex: offset + index, entries: [entry] };
    } else if (current !== undefined) {
      current.entries.push(entry);
    }
  }
  if (current !== undefined) turns.push(finishTurn(current, offset + entries.length - 1, false));
  return Object.freeze(turns.map((turn) => deepFreeze(turn)));
}

export function entryTimestampMilliseconds(entry: SnapshotEntry): number | null {
  const raw = entry.raw as Record<string, unknown>;
  const message = isRecord(raw.message) ? raw.message : undefined;
  if (entry.type === "message" && message?.role === "user") {
    const submittedAt = parseTimestamp(message.timestamp);
    if (submittedAt !== null) return submittedAt;
  }
  const persistedAt = parseTimestamp(entry.timestamp);
  if (persistedAt !== null) return persistedAt;
  return parseTimestamp(message?.timestamp);
}

function parseTimestamp(timestamp: unknown): number | null {
  if (typeof timestamp === "number" && isDateTimeValue(timestamp)) return timestamp;
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    if (isDateTimeValue(parsed)) return parsed;
  }
  return null;
}

export function millisecondsToIso(timestamp: number | null): string | null {
  return timestamp !== null && isDateTimeValue(timestamp) ? new Date(timestamp).toISOString() : null;
}

function finishTurn(
  turn: { user: SnapshotEntry; startIndex: number; entries: SnapshotEntry[] },
  endIndex: number,
  superseded: boolean,
): InternalTurn {
  const lastAssistant = turn.entries.findLast(isAssistantEntry);
  const stopReason = lastAssistant === undefined ? null : assistantStopReason(lastAssistant);
  const terminal = stopReason !== null && TERMINAL_REASONS.has(stopReason);
  const status = terminal ? terminalStatus(stopReason!) : (superseded ? "superseded" : "incomplete");
  const terminalEntryId = terminal ? lastAssistant!.id : null;
  const ending = terminal ? lastAssistant! : turn.entries.at(-1)!;
  return {
    userEntryId: turn.user.id,
    startIndex: turn.startIndex,
    endIndex,
    startTimestamp: millisecondsToIso(entryTimestampMilliseconds(turn.user)),
    endTimestamp: millisecondsToIso(entryTimestampMilliseconds(ending)),
    status,
    stopReason,
    settled: terminal || superseded,
    entries: Object.freeze(turn.entries.slice()),
    terminalEntryId,
  };
}

function terminalStatus(reason: string): TaskTurnStatus {
  switch (reason) {
    case "stop": return "completed";
    case "length": return "truncated";
    case "error": return "failed";
    case "aborted": return "aborted";
    default: return "incomplete";
  }
}

function toPublicTurn(turn: InternalTurn) {
  return {
    userEntryId: turn.userEntryId,
    startIndex: turn.startIndex,
    endIndex: turn.endIndex,
    startTimestamp: turn.startTimestamp,
    endTimestamp: turn.endTimestamp,
    status: turn.status,
    stopReason: turn.stopReason,
    settled: turn.settled,
  };
}

function isUserEntry(entry: SnapshotEntry): boolean {
  const raw = entry.raw as Record<string, unknown>;
  return entry.type === "message" && isRecord(raw.message) && raw.message.role === "user";
}

function isAssistantEntry(entry: SnapshotEntry): boolean {
  const raw = entry.raw as Record<string, unknown>;
  return entry.type === "message" && isRecord(raw.message) && raw.message.role === "assistant";
}

function assistantStopReason(entry: SnapshotEntry): string | null {
  const raw = entry.raw as Record<string, unknown>;
  const message = raw.message as Record<string, unknown>;
  return typeof message.stopReason === "string" ? message.stopReason : null;
}

function isDateTimeValue(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_DATE_TIME_VALUE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
