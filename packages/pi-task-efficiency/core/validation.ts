import {
  type JsonValue,
  type SnapshotEntry,
  type SnapshotWarning,
  SourceSnapshotError,
} from "./types.ts";

type JsonRecord = Record<string, JsonValue>;

const KNOWN_ENTRY_TYPES = new Set([
  "message",
  "thinking_level_change",
  "model_change",
  "compaction",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
]);
const ASSISTANT_STOP_REASONS = new Set([
  "pending",
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
  "deferred",
]);

export interface ValidSessionHeader {
  readonly id: string;
  readonly version: 2 | 3;
  readonly parentSessionId: string | null;
}

export interface ValidatedEntry {
  readonly entry: SnapshotEntry;
  readonly warning?: SnapshotWarning;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateHeader(value: unknown): ValidSessionHeader {
  if (!isRecord(value) || value.type !== "session") {
    throw invalidHeader("session header must be an object with type=session");
  }
  if (!nonEmptyString(value.id) || !nonEmptyString(value.cwd) || !isIsoTimestamp(value.timestamp)) {
    throw invalidHeader("session header requires non-empty id, cwd, and ISO timestamp");
  }
  if (!Number.isInteger(value.version) || (value.version !== 2 && value.version !== 3)) {
    if (value.version === undefined || value.version === 1 || typeof value.version === "number") {
      throw new SourceSnapshotError("unsupported-version", `unsupported Pi session version: ${String(value.version)}`);
    }
    throw invalidHeader("session header version must be a number");
  }
  if (value.parentSession !== undefined && !nonEmptyString(value.parentSession)) {
    throw invalidHeader("session header parentSession must be a non-empty string when present");
  }
  return {
    id: value.id,
    version: value.version,
    parentSessionId: value.parentSession ?? null,
  };
}

export function validateEntry(value: unknown, version: 2 | 3): ValidatedEntry {
  if (!isRecord(value)) throw invalidEntry("session entry must be a JSON object");
  if (!nonEmptyString(value.type) || !nonEmptyString(value.id) || !isIsoTimestamp(value.timestamp)) {
    throw invalidEntry("session entry requires non-empty type, id, and ISO timestamp");
  }
  if (value.parentId !== null && typeof value.parentId !== "string") {
    throw invalidEntry(`session entry ${value.id} has invalid parentId`);
  }

  const raw = value as unknown as JsonRecord;
  if (!KNOWN_ENTRY_TYPES.has(value.type)) {
    return {
      entry: {
        recognition: "unknown",
        type: value.type,
        id: value.id,
        parentId: value.parentId,
        timestamp: value.timestamp,
        raw,
      },
      warning: { code: "unknown_entry", entryId: value.id, entryType: value.type },
    };
  }

  validateKnownEntry(value, version);
  return {
    entry: {
      recognition: "known",
      type: value.type,
      id: value.id,
      parentId: value.parentId,
      timestamp: value.timestamp,
      raw,
    },
  };
}

function validateKnownEntry(entry: Record<string, unknown>, version: 2 | 3): void {
  switch (entry.type) {
    case "message":
      validateMessage(entry.message, version);
      return;
    case "thinking_level_change":
      requireNonEmpty(entry.thinkingLevel, "thinking_level_change.thinkingLevel");
      return;
    case "model_change":
      requireNonEmpty(entry.provider, "model_change.provider");
      requireNonEmpty(entry.modelId, "model_change.modelId");
      return;
    case "compaction":
      requireString(entry.summary, "compaction.summary");
      requireNonEmpty(entry.firstKeptEntryId, "compaction.firstKeptEntryId");
      requireFiniteNonNegative(entry.tokensBefore, "compaction.tokensBefore");
      return;
    case "branch_summary":
      requireString(entry.summary, "branch_summary.summary");
      requireNonEmpty(entry.fromId, "branch_summary.fromId");
      return;
    case "custom":
      requireNonEmpty(entry.customType, "custom.customType");
      return;
    case "custom_message":
      requireNonEmpty(entry.customType, "custom_message.customType");
      validateTextImageContent(entry.content, "custom_message.content", true);
      requireBoolean(entry.display, "custom_message.display");
      return;
    case "label":
      requireNonEmpty(entry.targetId, "label.targetId");
      if (entry.label !== undefined) requireString(entry.label, "label.label");
      return;
    case "session_info":
      if (entry.name !== undefined) requireString(entry.name, "session_info.name");
      return;
    default:
      throw invalidEntry(`unsupported known entry type: ${String(entry.type)}`);
  }
}

function validateMessage(value: unknown, version: 2 | 3): void {
  if (!isRecord(value) || typeof value.role !== "string") {
    throw invalidEntry("message entry requires an object with a role");
  }
  if (value.timestamp !== undefined && !isMetricTimestamp(value.timestamp)) {
    throw invalidEntry(`message.${value.role}.timestamp must be a finite timestamp when present`);
  }
  switch (value.role) {
    case "user":
      validateTextImageContent(value.content, "message.user.content", true);
      return;
    case "assistant":
      validateAssistantMessage(value);
      return;
    case "toolResult":
      validateToolResultMessage(value);
      return;
    case "bashExecution":
      validateBashExecutionMessage(value);
      return;
    case "custom":
      validateCustomMessage(value, "message.custom");
      return;
    case "branchSummary":
      requireString(value.summary, "message.branchSummary.summary");
      if (value.fromId !== null) requireNonEmpty(value.fromId, "message.branchSummary.fromId");
      return;
    case "compactionSummary":
      requireString(value.summary, "message.compactionSummary.summary");
      requireFiniteNonNegative(value.tokensBefore, "message.compactionSummary.tokensBefore");
      return;
    case "hookMessage":
      if (version !== 2) throw invalidEntry("hookMessage is only supported by Pi session version 2");
      validateCustomMessage(value, "message.hookMessage");
      return;
    default:
      throw invalidEntry(`unsupported message role for Pi session v${version}: ${value.role}`);
  }
}

function validateAssistantMessage(message: Record<string, unknown>): void {
  if (!Array.isArray(message.content)) throw invalidEntry("message.assistant.content must be an array");
  for (const [index, block] of message.content.entries()) {
    if (!isRecord(block) || typeof block.type !== "string") {
      throw invalidEntry(`message.assistant.content[${index}] must be a typed block`);
    }
    switch (block.type) {
      case "text":
        requireString(block.text, `message.assistant.content[${index}].text`);
        break;
      case "thinking":
        requireString(block.thinking, `message.assistant.content[${index}].thinking`);
        break;
      case "toolCall":
        requireNonEmpty(block.id, `message.assistant.content[${index}].id`);
        requireNonEmpty(block.name, `message.assistant.content[${index}].name`);
        if (!isRecord(block.arguments)) {
          throw invalidEntry(`message.assistant.content[${index}].arguments must be an object`);
        }
        break;
      default:
        throw invalidEntry(`message.assistant.content[${index}] has unsupported block type ${block.type}`);
    }
  }
  requireNonEmpty(message.provider, "message.assistant.provider");
  requireNonEmpty(message.model, "message.assistant.model");
  requireNonEmpty(message.api, "message.assistant.api");
  if (typeof message.stopReason !== "string" || !ASSISTANT_STOP_REASONS.has(message.stopReason)) {
    throw invalidEntry(`message.assistant.stopReason is unsupported: ${String(message.stopReason)}`);
  }
  // Usage is a metric coverage concern. Pi can persist it late or partially.
}

function validateToolResultMessage(message: Record<string, unknown>): void {
  requireNonEmpty(message.toolCallId, "message.toolResult.toolCallId");
  requireNonEmpty(message.toolName, "message.toolResult.toolName");
  validateTextImageContent(message.content, "message.toolResult.content", true);
  requireBoolean(message.isError, "message.toolResult.isError");
}

function validateBashExecutionMessage(message: Record<string, unknown>): void {
  requireString(message.command, "message.bashExecution.command");
  requireString(message.output, "message.bashExecution.output");
  if (message.exitCode !== undefined && (!Number.isInteger(message.exitCode))) {
    throw invalidEntry("message.bashExecution.exitCode must be an integer when present");
  }
  requireBoolean(message.cancelled, "message.bashExecution.cancelled");
  requireBoolean(message.truncated, "message.bashExecution.truncated");
  if (message.fullOutputPath !== undefined) requireString(message.fullOutputPath, "message.bashExecution.fullOutputPath");
}

function validateCustomMessage(message: Record<string, unknown>, label: string): void {
  requireNonEmpty(message.customType, `${label}.customType`);
  validateTextImageContent(message.content, `${label}.content`, true);
  requireBoolean(message.display, `${label}.display`);
}

function validateTextImageContent(value: unknown, label: string, allowString: boolean): void {
  if (allowString && typeof value === "string") return;
  if (!Array.isArray(value)) throw invalidEntry(`${label} must be a string or text/image block array`);
  for (const [index, block] of value.entries()) {
    if (!isRecord(block) || typeof block.type !== "string") {
      throw invalidEntry(`${label}[${index}] must be a typed block`);
    }
    if (block.type === "text") {
      requireString(block.text, `${label}[${index}].text`);
      continue;
    }
    if (block.type === "image") {
      requireString(block.data, `${label}[${index}].data`);
      requireNonEmpty(block.mimeType, `${label}[${index}].mimeType`);
      continue;
    }
    throw invalidEntry(`${label}[${index}] has unsupported block type ${block.type}`);
  }
}

function isMetricTimestamp(value: unknown): boolean {
  return isFiniteNonNegative(value)
    || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
}

function requireString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw invalidEntry(`${label} must be a string`);
}

function requireNonEmpty(value: unknown, label: string): asserts value is string {
  if (!nonEmptyString(value)) throw invalidEntry(`${label} must be a non-empty string`);
}

function requireBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") throw invalidEntry(`${label} must be a boolean`);
}

function requireFiniteNonNegative(value: unknown, label: string): asserts value is number {
  if (!isFiniteNonNegative(value)) throw invalidEntry(`${label} must be a finite non-negative number`);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function invalidHeader(message: string): SourceSnapshotError {
  return new SourceSnapshotError("invalid-header", message);
}

function invalidEntry(message: string): SourceSnapshotError {
  return new SourceSnapshotError("invalid-entry", message);
}
