import { isRecord } from "./validation.ts";

interface LifecycleUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
  readonly total: number;
}

export interface LifecycleRecord {
  readonly recordVersion: 2 | 3;
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly isBackground: boolean;
  readonly invocationKind: "fresh" | "resume";
  readonly invocationSource: "tool" | "service";
  readonly invocationIndex: number;
  readonly toolCallId: string | null;
  readonly sessionState: "created" | "not-created";
  readonly sessionId: string | null;
  readonly outputFile: string | null;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly invocationToolUses: number;
  readonly invocationUsage: LifecycleUsage;
}

const V2_STATUSES = new Set(["completed", "steered", "aborted", "stopped", "error"]);
const V3_OUTCOMES = new Set(["completed", "turn_limit", "timeout", "queue_timeout", "cancelled", "error"]);
const USAGE_FIELDS = ["input", "output", "cacheWrite", "total"] as const;

/** Both consumers validate persisted records through this single version boundary. */
export function parseLifecycleRecord(value: unknown): { record: LifecycleRecord | null; unsupported: boolean } {
  if (!isRecord(value) || !Number.isSafeInteger(value.recordVersion)) return { record: null, unsupported: false };
  if (value.recordVersion !== 2 && value.recordVersion !== 3) return { record: null, unsupported: true };
  const status = value.recordVersion === 2 ? value.status : value.outcome;
  if (!nonEmptyString(value.id) || !nonEmptyString(value.type) || !sanitized(value.description)
    || typeof value.isBackground !== "boolean" || typeof status !== "string"
    || !(value.recordVersion === 2 ? V2_STATUSES : V3_OUTCOMES).has(status)
    || !validInvocation(value) || !validSessionIdentity(value, status)
    || !validTiming(value) || !validMetrics(value)
    || !(value.recordVersion === 2 ? validV2Payload(value) : validV3Fields(value))) {
    return { record: null, unsupported: false };
  }
  return {
    unsupported: false,
    record: {
      recordVersion: value.recordVersion,
      id: value.id,
      type: value.type,
      status,
      isBackground: value.isBackground,
      invocationKind: value.invocationKind as LifecycleRecord["invocationKind"],
      invocationSource: value.invocationSource as LifecycleRecord["invocationSource"],
      invocationIndex: value.invocationIndex as number,
      toolCallId: value.invocationSource === "tool" ? value.toolCallId as string : null,
      sessionState: value.sessionState as LifecycleRecord["sessionState"],
      sessionId: value.sessionState === "created" ? value.sessionId as string : null,
      outputFile: value.sessionState === "created" ? value.outputFile as string | undefined ?? null : null,
      startedAt: value.startedAt as number,
      completedAt: value.completedAt as number,
      invocationToolUses: value.invocationToolUses as number,
      invocationUsage: selectUsage(value.invocationUsage as LifecycleUsage),
    },
  };
}

function validInvocation(value: Record<string, unknown>): boolean {
  if ((value.invocationKind !== "fresh" && value.invocationKind !== "resume")
    || (value.invocationSource !== "tool" && value.invocationSource !== "service")
    || !positiveInteger(value.invocationIndex)) return false;
  if ((value.invocationKind === "fresh" && value.invocationIndex !== 1)
    || (value.invocationKind === "resume" && value.invocationIndex < 2)) return false;
  if (value.invocationSource === "tool") return nonEmptyString(value.toolCallId);
  return value.invocationKind === "fresh" && value.toolCallId === undefined;
}

function validSessionIdentity(value: Record<string, unknown>, status: string): boolean {
  if (value.sessionState === "created") {
    return nonEmptyString(value.sessionId)
      && (value.outputFile === undefined || nonEmptyString(value.outputFile));
  }
  const allowsMissing = value.recordVersion === 2
    ? status === "error" || status === "stopped"
    : status === "error" || status === "cancelled" || status === "queue_timeout";
  return value.sessionState === "not-created"
    && value.sessionId === undefined && value.outputFile === undefined && allowsMissing;
}

function validTiming(value: Record<string, unknown>): boolean {
  return finiteNonNegative(value.startedAt)
    && finiteNonNegative(value.completedAt)
    && finiteNonNegative(value.durationMs)
    && value.completedAt >= value.startedAt
    && value.durationMs === value.completedAt - value.startedAt;
}

function validMetrics(value: Record<string, unknown>): boolean {
  const invocationUsage = value.invocationUsage;
  const lifetimeUsage = value.lifetimeUsage;
  if (!nonNegativeInteger(value.invocationToolUses) || !nonNegativeInteger(value.lifetimeToolUses)
    || value.lifetimeToolUses < value.invocationToolUses
    || !validUsage(invocationUsage) || !validUsage(lifetimeUsage)) return false;
  return USAGE_FIELDS.every((field) => lifetimeUsage[field] >= invocationUsage[field]);
}

function validUsage(value: unknown): value is LifecycleUsage {
  return isRecord(value) && finiteNonNegative(value.input) && finiteNonNegative(value.output)
    && finiteNonNegative(value.cacheWrite) && finiteNonNegative(value.total)
    && value.total === value.input + value.output + value.cacheWrite;
}

function selectUsage(value: LifecycleUsage): LifecycleUsage {
  return { input: value.input, output: value.output, cacheWrite: value.cacheWrite, total: value.total };
}

function validV2Payload(value: Record<string, unknown>): boolean {
  if (value.status === "error") return typeof value.error === "string";
  if (value.status === "completed" || value.status === "steered" || value.status === "aborted") {
    return typeof value.result === "string";
  }
  return true;
}

function validV3Fields(value: Record<string, unknown>): boolean {
  return value.phase === "terminal"
    && nonNegativeInteger(value.invocationTurnCount) && nonNegativeInteger(value.lifetimeTurnCount)
    && value.lifetimeTurnCount >= value.invocationTurnCount
    && positiveInteger(value.maxTurns) && nonNegativeInteger(value.wrapUpTurns)
    && value.wrapUpTurns < value.maxTurns && positiveInteger(value.maxDurationSeconds)
    && (value.result === undefined || typeof value.result === "string")
    && (value.error === undefined || typeof value.error === "string");
}

function sanitized(value: unknown): value is string {
  return typeof value === "string" && value === value.replace(/[\t\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
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
