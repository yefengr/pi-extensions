export interface LifecycleRecordV2 {
  readonly id: string;
  readonly type: string;
  readonly status: "completed" | "steered" | "aborted" | "stopped" | "error";
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
  readonly invocationUsage: {
    readonly input: number;
    readonly output: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
}

export function parseLifecycleRecordV2(value: unknown): { record: LifecycleRecordV2 | null; unsupported: boolean } {
  if (!isRecord(value)) return { record: null, unsupported: false };
  if (value.recordVersion !== 2) return { record: null, unsupported: true };
  if (!nonEmptyString(value.id) || !nonEmptyString(value.type) || !sanitized(value.description)) {
    return { record: null, unsupported: false };
  }
  if (!isStatus(value.status) || typeof value.isBackground !== "boolean" || !isKind(value.invocationKind)
    || !isSource(value.invocationSource) || !positiveInteger(value.invocationIndex)) {
    return { record: null, unsupported: false };
  }
  if ((value.invocationKind === "fresh" && value.invocationIndex !== 1)
    || (value.invocationKind === "resume" && value.invocationIndex < 2)) {
    return { record: null, unsupported: false };
  }
  if (!validInvocation(value) || !validSessionIdentity(value) || !validTiming(value) || !validMetrics(value)
    || !validTerminalPayload(value)) {
    return { record: null, unsupported: false };
  }
  const record = value as Record<string, unknown>;
  return {
    unsupported: false,
    record: {
      id: record.id as string,
      type: record.type as string,
      status: record.status as LifecycleRecordV2["status"],
      isBackground: record.isBackground as boolean,
      invocationKind: record.invocationKind as LifecycleRecordV2["invocationKind"],
      invocationSource: record.invocationSource as LifecycleRecordV2["invocationSource"],
      invocationIndex: record.invocationIndex as number,
      toolCallId: record.invocationSource === "tool" ? record.toolCallId as string : null,
      sessionState: record.sessionState as LifecycleRecordV2["sessionState"],
      sessionId: record.sessionState === "created" ? record.sessionId as string : null,
      outputFile: record.sessionState === "created" ? record.outputFile as string | undefined ?? null : null,
      startedAt: record.startedAt as number,
      completedAt: record.completedAt as number,
      invocationToolUses: record.invocationToolUses as number,
      invocationUsage: record.invocationUsage as LifecycleRecordV2["invocationUsage"],
    },
  };
}

function validInvocation(value: Record<string, unknown>): boolean {
  if (value.invocationSource === "tool") return nonEmptyString(value.toolCallId);
  return value.invocationKind === "fresh" && value.toolCallId === undefined;
}

function validSessionIdentity(value: Record<string, unknown>): boolean {
  if (value.sessionState === "created") {
    return nonEmptyString(value.sessionId)
      && (value.outputFile === undefined || nonEmptyString(value.outputFile));
  }
  return value.sessionState === "not-created"
    && value.sessionId === undefined
    && value.outputFile === undefined
    && (value.status === "error" || value.status === "stopped");
}

function validTiming(value: Record<string, unknown>): boolean {
  return finiteNonNegative(value.startedAt)
    && finiteNonNegative(value.completedAt)
    && finiteNonNegative(value.durationMs)
    && value.completedAt >= value.startedAt
    && value.durationMs === value.completedAt - value.startedAt;
}

function validMetrics(value: Record<string, unknown>): boolean {
  if (!nonNegativeInteger(value.invocationToolUses) || !nonNegativeInteger(value.lifetimeToolUses)
    || value.lifetimeToolUses < value.invocationToolUses || !validUsage(value.invocationUsage)
    || !validUsage(value.lifetimeUsage)) {
    return false;
  }
  for (const field of ["input", "output", "cacheWrite", "total"] as const) {
    if (value.lifetimeUsage[field] < value.invocationUsage[field]) return false;
  }
  return true;
}

function validUsage(value: unknown): value is LifecycleRecordV2["invocationUsage"] {
  if (!isRecord(value)) return false;
  return finiteNonNegative(value.input)
    && finiteNonNegative(value.output)
    && finiteNonNegative(value.cacheWrite)
    && finiteNonNegative(value.total)
    && value.total === value.input + value.output + value.cacheWrite;
}

function validTerminalPayload(value: Record<string, unknown>): boolean {
  if (value.status === "error") return typeof value.error === "string";
  if (value.status === "completed" || value.status === "steered" || value.status === "aborted") {
    return typeof value.result === "string";
  }
  return true;
}

function isStatus(value: unknown): value is LifecycleRecordV2["status"] {
  return value === "completed" || value === "steered" || value === "aborted" || value === "stopped" || value === "error";
}

function isKind(value: unknown): value is LifecycleRecordV2["invocationKind"] {
  return value === "fresh" || value === "resume";
}

function isSource(value: unknown): value is LifecycleRecordV2["invocationSource"] {
  return value === "tool" || value === "service";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
