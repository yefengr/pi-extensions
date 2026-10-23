export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface SnapshotEntry {
  readonly recognition: "known" | "unknown";
  readonly type: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly raw: Readonly<Record<string, JsonValue>>;
}

export interface SnapshotWarning {
  readonly code: "unknown_entry";
  readonly entryId: string;
  readonly entryType: string;
}

export interface SourceSnapshot {
  readonly sourcePath: string;
  readonly sessionId: string;
  readonly sessionVersion: number;
  readonly parentSessionId: string | null;
  readonly digest: string;
  readonly byteLength: number;
  readonly capturedAt: string;
  readonly activeLeafId: string | null;
  readonly entries: readonly SnapshotEntry[];
  readonly activeBranch: readonly SnapshotEntry[];
  readonly warnings: readonly SnapshotWarning[];
}

export interface SnapshotLoaderDependencies {
  readonly readFile?: (sourcePath: string) => Promise<Uint8Array>;
  readonly now?: () => Date;
}

export interface SnapshotDifference {
  readonly field: "sourcePath" | "sessionId" | "digest" | "activeLeafId";
  readonly expected: string | null;
  readonly actual: string | null;
}

export interface SnapshotComparison {
  readonly matches: boolean;
  readonly differences: readonly SnapshotDifference[];
}

interface ProjectionEntryBase {
  readonly sourceEntryId: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly omissionIds: readonly string[];
}

export interface ProjectionUserEntry extends ProjectionEntryBase {
  readonly kind: "user";
  readonly textBlocks: readonly string[];
}

export interface ProjectionAssistantEntry extends ProjectionEntryBase {
  readonly kind: "assistant";
  readonly textBlocks: readonly string[];
  readonly provider: string;
  readonly model: string;
  readonly stopReason: string | null;
  readonly toolCalls: readonly { readonly id: string; readonly name: string }[];
}

export interface ProjectionToolResultEntry extends ProjectionEntryBase {
  readonly kind: "tool_result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly isError: boolean;
  readonly textBlocks?: readonly string[];
}

export interface ProjectionCompactionEntry extends ProjectionEntryBase {
  readonly kind: "compaction";
  readonly summary: string;
  readonly firstKeptEntryId: string;
  readonly tokensBefore: number;
}

export interface ProjectionBranchSummaryEntry extends ProjectionEntryBase {
  readonly kind: "branch_summary";
  readonly summary: string;
  readonly fromId: string;
}

export interface ProjectionSubagentEntry extends ProjectionEntryBase {
  readonly kind: "subagent";
  readonly record: {
    readonly recordVersion: number;
    readonly id: string;
    readonly type: string;
    readonly status: string;
    readonly invocationKind: "fresh" | "resume";
    readonly invocationIndex: number;
    readonly toolCallId: string | null;
    readonly sessionState: "created" | "not-created";
    readonly sessionId: string | null;
    readonly startedAt: number;
    readonly completedAt: number;
  };
}

export interface ProjectionMetadataEntry extends ProjectionEntryBase {
  readonly kind: "metadata";
  readonly entryType: string;
}

export interface ProjectionOtherEntry extends ProjectionEntryBase {
  readonly kind: "other";
  readonly entryType: string;
}

export type ProjectionEntry =
  | ProjectionUserEntry
  | ProjectionAssistantEntry
  | ProjectionToolResultEntry
  | ProjectionCompactionEntry
  | ProjectionBranchSummaryEntry
  | ProjectionSubagentEntry
  | ProjectionMetadataEntry
  | ProjectionOtherEntry;

export interface ProjectionOptions {
  readonly maxInlineToolResultBytes: number;
}

export interface ProjectionOmission {
  readonly id: string;
  readonly sourceEntryId: string;
  readonly field: string;
  readonly reason: "content_limit" | "not_projected" | "unsupported_entry";
  readonly byteLength: number;
  readonly sha256: string;
}

export interface SessionProjection {
  readonly schemaVersion: 1;
  readonly source: {
    readonly sessionId: string;
    readonly digest: string;
    readonly activeLeafId: string | null;
  };
  readonly options: ProjectionOptions;
  readonly entries: readonly ProjectionEntry[];
  readonly omissions: readonly ProjectionOmission[];
}

export type SnapshotErrorCode =
  | "invalid-utf8"
  | "invalid-json"
  | "incomplete-tail"
  | "blank-line"
  | "invalid-header"
  | "unsupported-version"
  | "invalid-entry"
  | "duplicate-entry-id"
  | "invalid-tree"
  | "missing-parent"
  | "cycle"
  | "invalid-options";

export class SourceSnapshotError extends Error {
  readonly code: SnapshotErrorCode;

  constructor(code: SnapshotErrorCode, message: string) {
    super(message);
    this.name = "SourceSnapshotError";
    this.code = code;
  }
}

export class SnapshotMismatchError extends Error {
  readonly differences: readonly SnapshotDifference[];

  constructor(differences: readonly SnapshotDifference[]) {
    super(`source snapshot mismatch: ${differences.map((difference) => difference.field).join(", ")}`);
    this.name = "SnapshotMismatchError";
    this.differences = differences;
  }
}
