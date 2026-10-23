import { deepFreeze } from "./freeze.ts";
import type { ProjectionEntry, SessionProjection } from "./types.ts";

const MAX_TEXT_BYTES = 4_096;
export const MAX_SCOPE_DETAIL_TEXT_BYTES = 16_384;
export const MAX_SCOPE_DETAIL_ENTRIES = 120;
export const MAX_SCOPE_DETAIL_BYTES = 48_000;
export const MAX_SCOPE_PAGE_ENTRIES = 80;
export const MAX_SCOPE_PAGE_BYTES = 32_000;

interface ScopeText {
  readonly text: string;
  readonly originalBytes: number;
  readonly truncated: boolean;
}

interface ScopeEntryBase {
  readonly sourceEntryId: string;
  readonly timestamp: string;
}

export type ScopeProjectionEntry =
  | (ScopeEntryBase & { readonly kind: "user"; readonly content: ScopeText })
  | (ScopeEntryBase & {
      readonly kind: "assistant";
      readonly content: ScopeText;
      readonly stopReason: string | null;
      readonly toolNames: readonly string[];
    })
  | (ScopeEntryBase & { readonly kind: "tool_error"; readonly toolName: string })
  | (ScopeEntryBase & { readonly kind: "compaction" | "branch_summary"; readonly content: ScopeText })
  | (ScopeEntryBase & {
      readonly kind: "subagent";
      readonly type: string;
      readonly status: string;
      readonly invocationKind: "fresh" | "resume";
    });

export interface ScopeProjection {
  readonly schemaVersion: 1;
  readonly source: SessionProjection["source"];
  readonly entries: readonly ScopeProjectionEntry[];
  readonly omitted: {
    readonly metadataEntries: number;
    readonly successfulToolResults: number;
    readonly omissionRecords: number;
    readonly omissionBytes: number;
  };
}

export interface ScopeProjectionPage {
  readonly schemaVersion: 1;
  readonly source: SessionProjection["source"];
  readonly totalEntries: number;
  readonly startCursor: number;
  readonly endCursor: number;
  readonly previousCursor: number | null;
  readonly entries: readonly ScopeProjectionEntry[];
  readonly omitted: ScopeProjection["omitted"];
}

export interface ScopeDetailProjection {
  readonly schemaVersion: 1;
  readonly source: SessionProjection["source"];
  readonly startEntryId: string;
  readonly endEntryId: string;
  readonly sourceEntryCount: number;
  readonly entries: readonly ScopeDetailEntry[];
}

export type ScopeDetailEntry = ScopeProjectionEntry
  | (ScopeEntryBase & {
      readonly kind: "tool_result";
      readonly toolName: string;
      readonly isError: boolean;
      readonly content?: ScopeText;
    })
  | (ScopeEntryBase & { readonly kind: "metadata" | "other"; readonly entryType: string });

export type ScopeDetailErrorCode = "invalid-range" | "range-too-large" | "output-too-large";

export class ScopeDetailError extends Error {
  readonly code: ScopeDetailErrorCode;

  constructor(code: ScopeDetailErrorCode, message: string) {
    super(message);
    this.name = "ScopeDetailError";
    this.code = code;
  }
}

export type ScopePageErrorCode = "invalid-cursor" | "output-too-large";

export class ScopePageError extends Error {
  readonly code: ScopePageErrorCode;

  constructor(code: ScopePageErrorCode, message: string) {
    super(message);
    this.name = "ScopePageError";
    this.code = code;
  }
}

/** Builds the compact, model-facing timeline used only for semantic task-boundary selection. */
export function buildScopeProjection(projection: SessionProjection): ScopeProjection {
  const entries = projection.entries.flatMap(projectCompactEntry);
  let metadataEntries = 0;
  let successfulToolResults = 0;
  for (const entry of projection.entries) {
    if (entry.kind === "metadata" || entry.kind === "other") metadataEntries += 1;
    if (entry.kind === "tool_result" && !entry.isError) successfulToolResults += 1;
  }
  return deepFreeze({
    schemaVersion: 1,
    source: projection.source,
    entries,
    omitted: {
      metadataEntries,
      successfulToolResults,
      omissionRecords: projection.omissions.length,
      omissionBytes: projection.omissions.reduce((total, omission) => total + omission.byteLength, 0),
    },
  });
}

/**
 * Returns a bounded page of compact entries ending at the exclusive `beforeCursor` compact-entry index.
 * Omitting `beforeCursor` reads the most recent page; feed the returned `previousCursor` back in to read the page before it.
 * Cursors in [0, totalEntries] are accepted; every page keeps entry order and never overlaps its neighbors.
 */
export function buildScopeProjectionPage(
  scope: ScopeProjection,
  beforeCursor?: number,
): ScopeProjectionPage {
  const endCursor = beforeCursor ?? scope.entries.length;
  if (!Number.isSafeInteger(endCursor) || endCursor < 0 || endCursor > scope.entries.length) {
    throw new ScopePageError(
      "invalid-cursor",
      `scope page cursor must be an integer between 0 and ${scope.entries.length}`,
    );
  }

  let startCursor = Math.max(0, endCursor - MAX_SCOPE_PAGE_ENTRIES);
  let page = createScopePage(scope, startCursor, endCursor);
  // Shrink the page until it fits the byte budget.
  while (startCursor < endCursor - 1 && pageByteLength(page) > MAX_SCOPE_PAGE_BYTES) {
    startCursor += 1;
    page = createScopePage(scope, startCursor, endCursor);
  }
  if (pageByteLength(page) > MAX_SCOPE_PAGE_BYTES) {
    throw new ScopePageError("output-too-large", `scope page is limited to ${MAX_SCOPE_PAGE_BYTES} bytes`);
  }
  return page;
}

function createScopePage(scope: ScopeProjection, startCursor: number, endCursor: number): ScopeProjectionPage {
  return deepFreeze({
    schemaVersion: 1 as const,
    source: scope.source,
    totalEntries: scope.entries.length,
    startCursor,
    endCursor,
    previousCursor: startCursor > 0 ? startCursor : null,
    entries: scope.entries.slice(startCursor, endCursor),
    omitted: scope.omitted,
  });
}

function pageByteLength(page: ScopeProjectionPage): number {
  return Buffer.byteLength(JSON.stringify(page), "utf8");
}

/** Returns a bounded detailed slice without exposing omission hashes or tool-result bodies. */
export function buildScopeDetailProjection(
  projection: SessionProjection,
  startEntryId: string,
  endEntryId: string,
): ScopeDetailProjection {
  const startIndex = projection.entries.findIndex((entry) => entry.sourceEntryId === startEntryId);
  const endIndex = projection.entries.findIndex((entry) => entry.sourceEntryId === endEntryId);
  if (startIndex < 0 || endIndex < 0 || startIndex > endIndex) {
    throw new ScopeDetailError("invalid-range", "scope detail endpoints must be ordered projection entries");
  }
  const selected = projection.entries.slice(startIndex, endIndex + 1);
  if (selected.length > MAX_SCOPE_DETAIL_ENTRIES) {
    throw new ScopeDetailError("range-too-large", `scope detail is limited to ${MAX_SCOPE_DETAIL_ENTRIES} source entries`);
  }
  const detail = deepFreeze({
    schemaVersion: 1 as const,
    source: projection.source,
    startEntryId,
    endEntryId,
    sourceEntryCount: selected.length,
    entries: selected.flatMap(projectDetailEntry),
  });
  if (Buffer.byteLength(JSON.stringify(detail), "utf8") > MAX_SCOPE_DETAIL_BYTES) {
    throw new ScopeDetailError("output-too-large", `scope detail is limited to ${MAX_SCOPE_DETAIL_BYTES} bytes`);
  }
  return detail;
}

function projectCompactEntry(entry: ProjectionEntry): readonly ScopeProjectionEntry[] {
  switch (entry.kind) {
    case "user":
      return [{ ...base(entry), kind: "user", content: scopeText(entry.textBlocks) }];
    case "assistant":
      return [{
        ...base(entry),
        kind: "assistant",
        content: scopeText(entry.textBlocks),
        stopReason: entry.stopReason,
        toolNames: entry.toolCalls.map((call) => call.name),
      }];
    case "tool_result":
      return entry.isError ? [{ ...base(entry), kind: "tool_error", toolName: entry.toolName }] : [];
    case "compaction":
    case "branch_summary":
      return [{ ...base(entry), kind: entry.kind, content: scopeText([entry.summary]) }];
    case "subagent":
      return [{
        ...base(entry),
        kind: "subagent",
        type: entry.record.type,
        status: entry.record.status,
        invocationKind: entry.record.invocationKind,
      }];
    case "metadata":
    case "other":
      return [];
  }
}

function projectDetailEntry(entry: ProjectionEntry): readonly ScopeDetailEntry[] {
  if (entry.kind === "user") {
    return [{ ...base(entry), kind: "user", content: scopeText(entry.textBlocks, MAX_SCOPE_DETAIL_TEXT_BYTES) }];
  }
  if (entry.kind === "assistant") {
    return [{
      ...base(entry),
      kind: "assistant",
      content: scopeText(entry.textBlocks, MAX_SCOPE_DETAIL_TEXT_BYTES),
      stopReason: entry.stopReason,
      toolNames: entry.toolCalls.map((call) => call.name),
    }];
  }
  if (entry.kind === "compaction" || entry.kind === "branch_summary") {
    return [{ ...base(entry), kind: entry.kind, content: scopeText([entry.summary], MAX_SCOPE_DETAIL_TEXT_BYTES) }];
  }
  if (entry.kind === "tool_result") {
    const content = entry.textBlocks === undefined
      ? {}
      : { content: scopeText(entry.textBlocks, MAX_SCOPE_DETAIL_TEXT_BYTES) };
    return [{ ...base(entry), kind: "tool_result", toolName: entry.toolName, isError: entry.isError, ...content }];
  }
  if (entry.kind === "metadata" || entry.kind === "other") {
    return [{ ...base(entry), kind: entry.kind, entryType: entry.entryType }];
  }
  return projectCompactEntry(entry);
}

function base(entry: ProjectionEntry): ScopeEntryBase {
  return { sourceEntryId: entry.sourceEntryId, timestamp: entry.timestamp };
}

function scopeText(blocks: readonly string[], maxBytes = MAX_TEXT_BYTES): ScopeText {
  const source = blocks.join("\n");
  const originalBytes = Buffer.byteLength(source, "utf8");
  if (originalBytes <= maxBytes) return { text: source, originalBytes, truncated: false };

  let usedBytes = 0;
  let text = "";
  for (const character of source) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + bytes > maxBytes) break;
    text += character;
    usedBytes += bytes;
  }
  return { text, originalBytes, truncated: true };
}
