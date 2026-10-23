import { deepFreeze } from "./freeze.ts";
import { buildTaskEfficiencyReport } from "./report.ts";
import type { CostTotals, TaskEfficiencyDependencies, TokenTotals } from "./report-types.ts";
import { validateTaskRange } from "./range.ts";
import type { SnapshotEntry, SourceSnapshot } from "./types.ts";

export interface ReviewOverhead {
  readonly schemaVersion: 1;
  readonly reviewSessionId: string;
  readonly startEntryId: string;
  readonly endEntryId: string;
  readonly wallClockSpanSeconds: number | null;
  readonly modelResponses: number;
  readonly toolCalls: number;
  readonly kickoffBytes: number;
  readonly sessionBytes: number;
  readonly tokens: TokenTotals;
  readonly cost: CostTotals;
  readonly coverage: {
    readonly timeComplete: boolean;
    readonly usageComplete: boolean;
    readonly costComplete: boolean;
    readonly reasoningComplete: boolean;
    readonly requiredMetricsComplete: boolean;
  };
}

export class ReviewOverheadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewOverheadError";
  }
}

/** Computes review-session cost separately from the immutable source-task report. */
export async function buildReviewOverhead(
  snapshot: SourceSnapshot,
  dependencies?: TaskEfficiencyDependencies,
): Promise<ReviewOverhead> {
  const start = snapshot.activeBranch.find(isUserEntry);
  const end = snapshot.activeBranch.findLast(isTerminalAssistantEntry);
  if (start === undefined || end === undefined) {
    throw new ReviewOverheadError("review session must contain a user kickoff and terminal assistant response");
  }
  const range = validateTaskRange(snapshot, { startEntryId: start.id, endEntryId: end.id });
  const report = await buildTaskEfficiencyReport(snapshot, range, dependencies);
  return deepFreeze({
    schemaVersion: 1,
    reviewSessionId: snapshot.sessionId,
    startEntryId: start.id,
    endEntryId: end.id,
    wallClockSpanSeconds: report.time.wallClockSpanSeconds,
    modelResponses: report.modelEvents.responses + (report.subagents?.modelEvents?.responses ?? 0),
    toolCalls: report.tools.calls + (report.subagents?.tools?.calls ?? 0),
    kickoffBytes: userTextBytes(start),
    sessionBytes: snapshot.byteLength,
    tokens: report.usage.combined.tokens,
    cost: report.usage.combined.cost,
    coverage: {
      timeComplete: report.coverage.timeComplete,
      usageComplete: report.coverage.usageComplete,
      costComplete: report.coverage.costComplete,
      reasoningComplete: report.coverage.reasoningComplete,
      requiredMetricsComplete: report.coverage.complete,
    },
  });
}

function isUserEntry(entry: SnapshotEntry): boolean {
  if (entry.type !== "message") return false;
  const message = entry.raw.message;
  return isRecord(message) && message.role === "user";
}

function isTerminalAssistantEntry(entry: SnapshotEntry): boolean {
  if (entry.type !== "message") return false;
  const message = entry.raw.message;
  if (!isRecord(message) || message.role !== "assistant") return false;
  const stopReason = message.stopReason;
  return typeof stopReason === "string" && stopReason !== "toolUse";
}

function userTextBytes(entry: SnapshotEntry): number {
  const message = entry.raw.message;
  if (!isRecord(message)) return 0;
  const content = message.content;
  if (typeof content === "string") return Buffer.byteLength(content, "utf8");
  if (!Array.isArray(content)) return 0;
  let bytes = 0;
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    bytes += Buffer.byteLength(block.text, "utf8");
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
