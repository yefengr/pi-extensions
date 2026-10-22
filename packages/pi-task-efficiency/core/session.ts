import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildActiveBranch } from "./active-branch.ts";
import {
  type JsonValue,
  type SnapshotLoaderDependencies,
  type SourceSnapshot,
  type SnapshotComparison,
  type SnapshotDifference,
  type SnapshotEntry,
  type SnapshotWarning,
  SnapshotMismatchError,
  SourceSnapshotError,
} from "./types.ts";
import { validateEntry, validateHeader } from "./validation.ts";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** Loads a source file exactly once and derives every snapshot fact from that byte copy. */
export async function loadSourceSnapshot(
  sessionPath: string,
  dependencies: SnapshotLoaderDependencies = {},
): Promise<SourceSnapshot> {
  const sourcePath = path.resolve(sessionPath);
  const reader = dependencies.readFile ?? readFile;
  const bytes = Buffer.from(await reader(sourcePath));
  const text = decodeUtf8(bytes);
  const records = parseJsonl(text);
  const header = validateHeader(records[0]);
  const { entries, warnings } = validateEntries(records.slice(1), header.version);
  validateTree(entries);

  const activeBranch = buildActiveBranch(entries);
  const now = dependencies.now ?? (() => new Date());
  const capturedAt = now().toISOString();
  if (Number.isNaN(Date.parse(capturedAt))) {
    throw new SourceSnapshotError("invalid-header", "snapshot clock returned an invalid date");
  }

  return deepFreeze({
    sourcePath,
    sessionId: header.id,
    sessionVersion: header.version,
    parentSessionId: header.parentSessionId,
    digest: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    capturedAt,
    activeLeafId: entries.at(-1)?.id ?? null,
    entries,
    activeBranch,
    warnings,
  });
}

export function compareSourceSnapshots(
  expected: SourceSnapshot,
  current: SourceSnapshot,
): SnapshotComparison {
  const differences: SnapshotDifference[] = [];
  for (const field of ["sourcePath", "sessionId", "digest", "activeLeafId"] as const) {
    if (expected[field] !== current[field]) {
      differences.push({ field, expected: expected[field], actual: current[field] });
    }
  }
  return Object.freeze({ matches: differences.length === 0, differences: Object.freeze(differences) });
}

/** Returns the newly read snapshot only when it still matches the saved source identity. */
export function assertSnapshotMatches(expected: SourceSnapshot, current: SourceSnapshot): SourceSnapshot {
  const comparison = compareSourceSnapshots(expected, current);
  if (!comparison.matches) throw new SnapshotMismatchError(comparison.differences);
  return current;
}

export function validateTree(entries: readonly SnapshotEntry[]): void {
  if (entries.length === 0) return;

  const indices = new Map<string, number>();
  for (const [index, entry] of entries.entries()) {
    if (indices.has(entry.id)) {
      throw new SourceSnapshotError("duplicate-entry-id", `duplicate session entry id: ${entry.id}`);
    }
    indices.set(entry.id, index);
  }

  if (entries[0].parentId !== null) {
    throw new SourceSnapshotError("invalid-tree", "the first non-header entry must be the root");
  }

  for (const [index, entry] of entries.entries()) {
    if (index === 0) continue;
    if (entry.parentId === null) {
      throw new SourceSnapshotError("invalid-tree", `session entry ${entry.id} is a second root`);
    }
    if (entry.parentId.trim().length === 0) {
      throw new SourceSnapshotError("invalid-tree", `session entry ${entry.id} has an empty parentId`);
    }
    const parentIndex = indices.get(entry.parentId);
    if (parentIndex === undefined) {
      throw new SourceSnapshotError("invalid-tree", `session entry ${entry.id} has an orphan parent ${entry.parentId}`);
    }
    if (parentIndex >= index) {
      throw new SourceSnapshotError("invalid-tree", `session entry ${entry.id} points to a later parent ${entry.parentId}`);
    }
  }

  validateCompactionReferences(entries, indices);
}

function validateCompactionReferences(entries: readonly SnapshotEntry[], indices: ReadonlyMap<string, number>): void {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const entry of entries) {
    if (entry.type !== "compaction") continue;

    const firstKeptEntryId = entry.raw.firstKeptEntryId;
    let ancestorId = entry.parentId;
    while (ancestorId !== null) {
      if (ancestorId === firstKeptEntryId) break;
      const ancestor = byId.get(ancestorId);
      if (ancestor === undefined) {
        throw new SourceSnapshotError("invalid-tree", `compaction ${entry.id} has missing ancestor ${ancestorId}`);
      }
      ancestorId = ancestor.parentId;
    }

    if (ancestorId === null) {
      const targetIndex = typeof firstKeptEntryId === "string" ? indices.get(firstKeptEntryId) : undefined;
      const target = targetIndex === undefined ? "missing entry" : "non-ancestor entry";
      throw new SourceSnapshotError(
        "invalid-tree",
        `compaction ${entry.id} firstKeptEntryId must reference a strict ancestor, got ${target}`,
      );
    }
  }
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw new SourceSnapshotError("invalid-utf8", `session file is not valid UTF-8: ${errorMessage(error)}`);
  }
}

function parseJsonl(text: string): unknown[] {
  const hasFinalNewline = text.endsWith("\n");
  const lines = text.split("\n");
  const records: unknown[] = [];
  const lastLine = lines.length - 1;

  for (const [index, lineWithCarriageReturn] of lines.entries()) {
    if (hasFinalNewline && index === lastLine) continue;
    const line = lineWithCarriageReturn.endsWith("\r")
      ? lineWithCarriageReturn.slice(0, -1)
      : lineWithCarriageReturn;
    if (line.trim().length === 0) {
      throw new SourceSnapshotError("blank-line", `blank JSONL data line ${index + 1}`);
    }
    try {
      const value: unknown = JSON.parse(line);
      records.push(value);
    } catch (error) {
      if (index === lastLine && !hasFinalNewline) {
        throw new SourceSnapshotError("incomplete-tail", `incomplete JSONL tail at line ${index + 1}`);
      }
      throw new SourceSnapshotError("invalid-json", `invalid JSONL at line ${index + 1}: ${errorMessage(error)}`);
    }
  }

  if (records.length === 0) throw new SourceSnapshotError("invalid-header", "missing Pi session header");
  return records;
}

function validateEntries(
  values: readonly unknown[],
  version: 2 | 3,
): { entries: SnapshotEntry[]; warnings: SnapshotWarning[] } {
  const entries: SnapshotEntry[] = [];
  const warnings: SnapshotWarning[] = [];
  for (const value of values) {
    const validated = validateEntry(value, version);
    entries.push(validated.entry);
    if (validated.warning !== undefined) warnings.push(validated.warning);
  }
  return { entries, warnings };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const property of Object.getOwnPropertyNames(value)) {
    const nested = (value as Record<string, unknown>)[property];
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function snapshotRawEntry(entry: SnapshotEntry): Readonly<Record<string, JsonValue>> {
  return entry.raw;
}
