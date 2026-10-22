import type { ProjectionSubagentEntry } from "./types.ts";
import { isRecord } from "./validation.ts";

type ProjectedLifecycleRecord = ProjectionSubagentEntry["record"];
type JsonRecord = Record<string, unknown>;
type TerminalStatus = "completed" | "steered" | "aborted" | "stopped" | "error";
type InvocationKind = "fresh" | "resume";
type InvocationSource = "tool" | "service";
type SessionState = "created" | "not-created";

interface LifecycleUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
  readonly total: number;
}

interface ValidLifecycleRecord {
  readonly recordVersion: 2;
  readonly id: string;
  readonly type: string;
  readonly description: string;
  readonly status: TerminalStatus;
  readonly isBackground: boolean;
  readonly invocationKind: InvocationKind;
  readonly invocationSource: InvocationSource;
  readonly invocationIndex: number;
  readonly toolCallId?: string;
  readonly sessionState: SessionState;
  readonly sessionId?: string;
  readonly outputFile?: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly result?: string;
  readonly error?: string;
  readonly invocationToolUses: number;
  readonly invocationUsage: LifecycleUsage;
  readonly lifetimeToolUses: number;
  readonly lifetimeUsage: LifecycleUsage;
}

const TERMINAL_STATUSES = new Set<TerminalStatus>(["completed", "steered", "aborted", "stopped", "error"]);
const USAGE_FIELDS = ["input", "output", "cacheWrite", "total"] as const;

/** Validates persisted lifecycle-v2 data before selecting the fixed safe projection fields. */
export function projectLifecycleRecordV2(value: unknown): ProjectedLifecycleRecord | null {
  if (!isRecord(value) || !isValidLifecycleRecord(value)) return null;

  return {
    recordVersion: 2,
    id: value.id,
    type: value.type,
    status: value.status,
    invocationKind: value.invocationKind,
    invocationIndex: value.invocationIndex,
    toolCallId: value.invocationSource === "tool" ? value.toolCallId! : null,
    sessionState: value.sessionState,
    sessionId: value.sessionState === "created" ? value.sessionId! : null,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
  };
}

function isValidLifecycleRecord(value: JsonRecord): value is JsonRecord & ValidLifecycleRecord {
  return value.recordVersion === 2
    && nonEmptyString(value.id)
    && nonEmptyString(value.type)
    && isSanitizedDescription(value.description)
    && isTerminalStatus(value.status)
    && typeof value.isBackground === "boolean"
    && validInvocation(value)
    && validSessionIdentity(value)
    && validTiming(value)
    && validMetrics(value)
    && validTerminalPayload(value);
}

function validInvocation(value: JsonRecord): boolean {
  if ((value.invocationKind !== "fresh" && value.invocationKind !== "resume")
    || (value.invocationSource !== "tool" && value.invocationSource !== "service")
    || !positiveInteger(value.invocationIndex)) {
    return false;
  }
  if ((value.invocationKind === "fresh" && value.invocationIndex !== 1)
    || (value.invocationKind === "resume" && value.invocationIndex < 2)) {
    return false;
  }
  if (value.invocationSource === "tool") return nonEmptyString(value.toolCallId);
  return value.invocationKind === "fresh" && value.toolCallId === undefined;
}

function validSessionIdentity(value: JsonRecord): boolean {
  if (value.sessionState === "created") {
    return nonEmptyString(value.sessionId)
      && (value.outputFile === undefined || nonEmptyString(value.outputFile));
  }
  return value.sessionState === "not-created"
    && value.sessionId === undefined
    && value.outputFile === undefined
    && (value.status === "error" || value.status === "stopped");
}

function validTiming(value: JsonRecord): boolean {
  return finiteNonNegative(value.startedAt)
    && finiteNonNegative(value.completedAt)
    && finiteNonNegative(value.durationMs)
    && value.completedAt >= value.startedAt
    && value.durationMs === value.completedAt - value.startedAt;
}

function validMetrics(value: JsonRecord): boolean {
  const invocationUsage = value.invocationUsage;
  const lifetimeUsage = value.lifetimeUsage;
  if (!nonNegativeInteger(value.invocationToolUses)
    || !nonNegativeInteger(value.lifetimeToolUses)
    || value.lifetimeToolUses < value.invocationToolUses
    || !validUsage(invocationUsage)
    || !validUsage(lifetimeUsage)) {
    return false;
  }

  return USAGE_FIELDS.every((field) => lifetimeUsage[field] >= invocationUsage[field]);
}

function validUsage(value: unknown): value is LifecycleUsage {
  if (!isRecord(value)) return false;
  const input = value.input;
  const output = value.output;
  const cacheWrite = value.cacheWrite;
  const total = value.total;
  return finiteNonNegative(input)
    && finiteNonNegative(output)
    && finiteNonNegative(cacheWrite)
    && finiteNonNegative(total)
    && total === input + output + cacheWrite;
}

function validTerminalPayload(value: JsonRecord): boolean {
  if (value.status === "error") return typeof value.error === "string";
  if (value.status === "completed" || value.status === "steered" || value.status === "aborted") {
    return typeof value.result === "string";
  }
  return true;
}

function isSanitizedDescription(value: unknown): value is string {
  return typeof value === "string" && value === sanitizeDescription(value);
}

function isTerminalStatus(value: unknown): value is TerminalStatus {
  return typeof value === "string" && TERMINAL_STATUSES.has(value as TerminalStatus);
}

function sanitizeDescription(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
