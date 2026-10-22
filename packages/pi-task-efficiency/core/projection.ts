import { createHash } from "node:crypto";

import {
  type ProjectionEntry,
  type ProjectionMetadataEntry,
  type ProjectionOmission,
  type ProjectionOptions,
  type SessionProjection,
  type SnapshotEntry,
  type SourceSnapshot,
  SourceSnapshotError,
} from "./types.ts";
import { projectLifecycleRecordV2 } from "./lifecycle-record.ts";

type OmissionReason = ProjectionOmission["reason"];
type JsonRecord = Record<string, unknown>;

/** Builds a deterministic, content-bounded timeline without reading any source file. */
export function buildSessionProjection(
  snapshot: SourceSnapshot,
  inputOptions?: Partial<ProjectionOptions>,
): SessionProjection {
  const options = normalizeOptions(inputOptions);
  const omissions: ProjectionOmission[] = [];
  const entries = snapshot.activeBranch.map((entry) => projectEntry(entry, options, omissions));

  return deepFreeze({
    schemaVersion: 1,
    source: {
      sessionId: snapshot.sessionId,
      digest: snapshot.digest,
      activeLeafId: snapshot.activeLeafId,
    },
    options,
    entries,
    omissions,
  });
}

function normalizeOptions(input: Partial<ProjectionOptions> | undefined): ProjectionOptions {
  const value = input?.maxInlineToolResultBytes ?? 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new SourceSnapshotError("invalid-options", "maxInlineToolResultBytes must be a non-negative integer");
  }
  return Object.freeze({ maxInlineToolResultBytes: value });
}

function projectEntry(
  entry: SnapshotEntry,
  options: ProjectionOptions,
  omissions: ProjectionOmission[],
): ProjectionEntry {
  const omissionIds: string[] = [];
  const base = {
    sourceEntryId: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
    omissionIds,
  };
  const raw = entry.raw as unknown as JsonRecord;

  if (entry.recognition === "unknown") {
    omit(entry, omissionIds, omissions, "raw", "unsupported_entry", entry.raw);
    return freezeEntry({ ...base, kind: "other", entryType: entry.type });
  }

  switch (entry.type) {
    case "message":
      return projectMessage(entry, raw, base, options, omissions);
    case "compaction":
      return freezeEntry({
        ...base,
        kind: "compaction",
        summary: raw.summary as string,
        firstKeptEntryId: raw.firstKeptEntryId as string,
        tokensBefore: raw.tokensBefore as number,
      });
    case "branch_summary":
      return freezeEntry({
        ...base,
        kind: "branch_summary",
        summary: raw.summary as string,
        fromId: raw.fromId as string,
      });
    case "custom":
      return projectCustomEntry(entry, raw, base, omissions);
    case "custom_message":
      omitTextImageContent(entry, omissionIds, omissions, raw.content, "content");
      return metadata(base, entry.type);
    default:
      return metadata(base, entry.type);
  }
}

function projectMessage(
  entry: SnapshotEntry,
  raw: JsonRecord,
  base: ProjectionBase,
  options: ProjectionOptions,
  omissions: ProjectionOmission[],
): ProjectionEntry {
  const message = raw.message as JsonRecord;
  const omissionIds = base.omissionIds;
  switch (message.role) {
    case "user":
      return freezeEntry({
        ...base,
        kind: "user",
        textBlocks: collectTextBlocks(entry, omissionIds, omissions, message.content, "message.content"),
      });
    case "assistant":
      return projectAssistant(entry, message, base, omissions);
    case "toolResult":
      return projectToolResult(entry, message, base, options, omissions);
    case "bashExecution":
      omit(entry, omissionIds, omissions, "message.command", "not_projected", message.command);
      omit(entry, omissionIds, omissions, "message.output", "not_projected", message.output);
      return metadata(base, entry.type);
    case "custom":
    case "hookMessage":
      omitTextImageContent(entry, omissionIds, omissions, message.content, "message.content");
      return metadata(base, entry.type);
    case "branchSummary":
    case "compactionSummary":
      omit(entry, omissionIds, omissions, "message.summary", "not_projected", message.summary);
      return metadata(base, entry.type);
    default:
      return metadata(base, entry.type);
  }
}

function projectAssistant(
  entry: SnapshotEntry,
  message: JsonRecord,
  base: ProjectionBase,
  omissions: ProjectionOmission[],
): ProjectionEntry {
  const textBlocks: string[] = [];
  const toolCalls: { id: string; name: string }[] = [];
  const blocks = message.content as unknown[];

  for (const [index, value] of blocks.entries()) {
    const block = value as JsonRecord;
    if (block.type === "text") {
      textBlocks.push(block.text as string);
      continue;
    }
    if (block.type === "thinking") {
      omit(entry, base.omissionIds, omissions, `message.content[${index}]`, "not_projected", block);
      continue;
    }
    toolCalls.push({ id: block.id as string, name: block.name as string });
    omit(entry, base.omissionIds, omissions, `message.content[${index}].arguments`, "not_projected", block.arguments);
  }

  return freezeEntry({
    ...base,
    kind: "assistant",
    textBlocks,
    provider: message.provider as string,
    model: message.model as string,
    stopReason: message.stopReason as string,
    toolCalls,
  });
}

function projectToolResult(
  entry: SnapshotEntry,
  message: JsonRecord,
  base: ProjectionBase,
  options: ProjectionOptions,
  omissions: ProjectionOmission[],
): ProjectionEntry {
  const content = message.content;
  const byteLength = textContentByteLength(content);
  const inline = options.maxInlineToolResultBytes > 0 && byteLength <= options.maxInlineToolResultBytes;
  const textBlocks = inline
    ? collectToolResultText(entry, base.omissionIds, omissions, content, true)
    : collectToolResultText(entry, base.omissionIds, omissions, content, false);

  return freezeEntry({
    ...base,
    kind: "tool_result",
    toolCallId: message.toolCallId as string,
    toolName: message.toolName as string,
    isError: message.isError as boolean,
    ...(inline ? { textBlocks } : {}),
  });
}

function projectCustomEntry(
  entry: SnapshotEntry,
  raw: JsonRecord,
  base: ProjectionBase,
  omissions: ProjectionOmission[],
): ProjectionEntry {
  if (Object.hasOwn(raw, "data")) {
    omit(entry, base.omissionIds, omissions, "data", "not_projected", raw.data);
  }
  if (raw.customType === "subagents:record") {
    const record = projectLifecycleRecordV2(raw.data);
    if (record !== null) return freezeEntry({ ...base, kind: "subagent", record });
  }
  return metadata(base, entry.type);
}

function collectTextBlocks(
  entry: SnapshotEntry,
  omissionIds: string[],
  omissions: ProjectionOmission[],
  content: unknown,
  field: string,
): string[] {
  if (typeof content === "string") return [content];
  const textBlocks: string[] = [];
  for (const [index, value] of (content as unknown[]).entries()) {
    const block = value as JsonRecord;
    if (block.type === "text") {
      textBlocks.push(block.text as string);
    } else {
      omit(entry, omissionIds, omissions, `${field}[${index}]`, "not_projected", block);
    }
  }
  return textBlocks;
}

function collectToolResultText(
  entry: SnapshotEntry,
  omissionIds: string[],
  omissions: ProjectionOmission[],
  content: unknown,
  inline: boolean,
): string[] {
  if (typeof content === "string") {
    if (inline) return [content];
    omit(entry, omissionIds, omissions, "message.content", "content_limit", content);
    return [];
  }

  const textBlocks: string[] = [];
  for (const [index, value] of (content as unknown[]).entries()) {
    const block = value as JsonRecord;
    if (block.type === "image") {
      omit(entry, omissionIds, omissions, `message.content[${index}]`, "not_projected", block);
      continue;
    }
    if (inline) textBlocks.push(block.text as string);
    else omit(entry, omissionIds, omissions, `message.content[${index}].text`, "content_limit", block.text);
  }
  return textBlocks;
}

function omitTextImageContent(
  entry: SnapshotEntry,
  omissionIds: string[],
  omissions: ProjectionOmission[],
  content: unknown,
  field: string,
): void {
  if (typeof content === "string") {
    omit(entry, omissionIds, omissions, field, "not_projected", content);
    return;
  }
  for (const [index, value] of (content as unknown[]).entries()) {
    omit(entry, omissionIds, omissions, `${field}[${index}]`, "not_projected", value);
  }
}

function textContentByteLength(content: unknown): number {
  if (typeof content === "string") return Buffer.byteLength(content, "utf8");
  let total = 0;
  for (const value of content as unknown[]) {
    const block = value as JsonRecord;
    if (block.type === "text") total += Buffer.byteLength(block.text as string, "utf8");
  }
  return total;
}

function omit(
  entry: SnapshotEntry,
  omissionIds: string[],
  omissions: ProjectionOmission[],
  field: string,
  reason: OmissionReason,
  value: unknown,
): void {
  const bytes = omissionBytes(value);
  const id = createHash("sha256").update(`${entry.id}\u0000${field}`, "utf8").digest("hex");
  omissionIds.push(id);
  omissions.push({
    id,
    sourceEntryId: entry.id,
    field,
    reason,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function omissionBytes(value: unknown): Buffer {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.from(JSON.stringify(value), "utf8");
}

interface ProjectionBase {
  readonly sourceEntryId: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly omissionIds: string[];
}

function metadata(base: ProjectionBase, entryType: string): ProjectionMetadataEntry {
  return freezeEntry({ ...base, kind: "metadata", entryType });
}

function freezeEntry<T extends ProjectionEntry>(entry: T): T {
  return deepFreeze(entry);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const property of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[property]);
  }
  return Object.freeze(value);
}
