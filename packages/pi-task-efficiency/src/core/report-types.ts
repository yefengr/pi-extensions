import type { SourceSnapshot, SnapshotEntry } from "./types.ts";

export type TaskRangeErrorCode =
  | "invalid-range"
  | "range-start-not-user"
  | "range-final-incomplete"
  | "range-final-superseded";

export class TaskRangeError extends Error {
  readonly code: TaskRangeErrorCode;

  constructor(code: TaskRangeErrorCode, message: string) {
    super(message);
    this.name = "TaskRangeError";
    this.code = code;
  }
}

export interface TaskRangeSelection {
  readonly startEntryId: string;
  readonly endEntryId: string;
}

export type TaskTurnStatus = "completed" | "truncated" | "failed" | "aborted" | "superseded" | "incomplete";

export interface ValidatedTaskTurn {
  readonly userEntryId: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startTimestamp: string | null;
  readonly endTimestamp: string | null;
  readonly status: TaskTurnStatus;
  readonly stopReason: string | null;
  readonly settled: boolean;
}

export interface ValidatedTaskRange {
  readonly source: {
    readonly sessionId: string;
    readonly digest: string;
    readonly activeLeafId: string | null;
  };
  readonly startEntryId: string;
  readonly endEntryId: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly entryCount: number;
  readonly turns: readonly ValidatedTaskTurn[];
}

export interface ReportTurn {
  readonly userEntryId: string;
  readonly startTimestamp: string | null;
  readonly endTimestamp: string | null;
  readonly status: TaskTurnStatus;
  readonly stopReason: string | null;
  readonly settled: boolean;
}

export interface TokenTotals {
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly reasoning: number | null;
  readonly totalTokens: number | null;
}

export interface CostTotals {
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly total: number | null;
}

export interface UsageByModel {
  readonly events: number;
  readonly tokens: TokenTotals;
  readonly cost: CostTotals;
}

export interface UsageAggregation {
  readonly events: number;
  readonly tokens: TokenTotals;
  readonly cost: CostTotals;
  readonly costBasis: "pi_session_recorded";
  readonly byModel: Readonly<Record<string, UsageByModel>>;
}

export interface ToolByName {
  readonly calls: number;
  readonly failures: number;
  readonly incompleteCalls: number;
}

export interface ToolMetrics {
  readonly calls: number;
  readonly batches: number;
  readonly failures: number;
  readonly incompleteCalls: number;
  readonly orphanResults: number;
  readonly byTool: Readonly<Record<string, ToolByName>>;
  readonly batchWaitSeconds: number | null;
  readonly criticalPathSeconds: number | null;
  readonly longestCallSeconds: number | null;
}

export interface ModelStatusCounts {
  readonly completed: number;
  readonly toolUse: number;
  readonly failed: number;
  readonly truncated: number;
  readonly aborted: number;
  readonly other: number;
}

export interface ModelByName {
  readonly responses: number;
  readonly failures: number;
  readonly automaticRetries: number;
  readonly statuses: ModelStatusCounts;
}

export interface ModelEventMetrics {
  readonly responses: number;
  readonly failures: number;
  readonly automaticRetries: number;
  readonly turnsWithFailures: number;
  readonly recoveredTurns: number;
  readonly failedTurns: number;
  readonly statuses: ModelStatusCounts;
  readonly byModel: Readonly<Record<string, ModelByName>>;
}

export interface TimeMetrics {
  readonly wallClockSpanSeconds: number | null;
  readonly userWaitSeconds: number | null;
  readonly agentActiveSeconds: number | null;
  readonly toolCriticalPathSeconds: number | null;
  readonly nonToolActiveSeconds: number | null;
}

export type SubagentIssueCode =
  | "child_discovery_failed"
  | "child_parse_failed"
  | "child_parent_mismatch"
  | "duplicate_child_session"
  | "missing_child_session"
  | "output_file_conflict"
  | "invalid_lifecycle_record"
  | "unsupported_lifecycle_version"
  | "duplicate_tool_call_id"
  | "duplicate_invocation_identity"
  | "conflicting_agent_identity"
  | "missing_lifecycle_record"
  | "unmatched_lifecycle_record"
  | "lifecycle_kind_mismatch"
  | "resume_identity_mismatch"
  | "overlapping_invocation_windows"
  | "multiply_owned_child_turn"
  | "empty_child_window"
  | "unsettled_child_turn"
  | "invocation_usage_mismatch"
  | "invocation_tool_count_mismatch";

export interface SubagentIssue {
  readonly code: SubagentIssueCode;
}

export interface ChildCoverage {
  readonly discoveryComplete: boolean;
  readonly identityAttributionComplete: boolean;
  readonly workflowAttributionComplete: boolean;
  readonly childSessionsSettled: boolean;
  readonly usageComplete: boolean;
  readonly costComplete: boolean;
  readonly complete: boolean;
}

export interface ChildTimeline {
  readonly parentActiveSeconds: number | null;
  readonly childActiveSeconds: number | null;
  readonly childWorkSeconds: number | null;
  readonly parentChildOverlapSeconds: number | null;
  readonly childParallelSeconds: number | null;
  readonly workflowCriticalPathSeconds: number | null;
  readonly overlappedAgentSeconds: number | null;
  readonly subagentWaitSeconds: number | null;
  readonly foregroundSubagentSeconds: number | null;
  readonly resultWaitSeconds: number | null;
  readonly waitDuringChildSeconds: number | null;
}

export interface SubagentMetrics {
  readonly invocations: number;
  readonly sessions: number;
  readonly fresh: number;
  readonly resumes: number;
  readonly notCreated: number;
  readonly timeline: ChildTimeline;
  readonly usage: UsageAggregation;
  readonly tools: ToolMetrics | null;
  readonly modelEvents: ModelEventMetrics | null;
  readonly issues: readonly SubagentIssue[];
  readonly coverage: ChildCoverage;
}

export interface ReportCoverage {
  readonly sessionComplete: true;
  readonly rangeComplete: true;
  readonly timeComplete: boolean;
  readonly usageComplete: boolean;
  readonly costComplete: boolean;
  readonly reasoningComplete: boolean;
  readonly toolTimingComplete: boolean;
  readonly modelEventsComplete: boolean;
  readonly subagents: ChildCoverage | null;
  readonly complete: boolean;
}

export interface TaskEfficiencyReport {
  readonly schemaVersion: 1;
  readonly source: {
    readonly sessionId: string;
    readonly digest: string;
    readonly activeLeafId: string | null;
  };
  readonly range: {
    readonly startEntryId: string;
    readonly endEntryId: string;
    readonly startTimestamp: string | null;
    readonly endTimestamp: string | null;
    readonly entryCount: number;
    readonly turns: readonly ReportTurn[];
  };
  readonly time: TimeMetrics;
  readonly usage: {
    readonly parent: UsageAggregation;
    readonly children: UsageAggregation | null;
    readonly combined: UsageAggregation;
  };
  readonly tools: ToolMetrics;
  readonly modelEvents: ModelEventMetrics;
  readonly subagents: SubagentMetrics | null;
  readonly coverage: ReportCoverage;
}

export interface TaskEfficiencyDependencies {
  readonly readChildDirectory?: (directory: string) => Promise<readonly string[]>;
  readonly loadChildSnapshot?: (sourcePath: string) => Promise<SourceSnapshot>;
}

export interface InternalTurn extends ValidatedTaskTurn {
  readonly entries: readonly SnapshotEntry[];
  readonly terminalEntryId: string | null;
}
