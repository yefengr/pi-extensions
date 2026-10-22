import { readdir } from "node:fs/promises";
import path from "node:path";

import { deepFreeze } from "./freeze.ts";
import { intervalSeconds, overlapSeconds, type Interval } from "./intervals.ts";
import { parseLifecycleRecordV2, type LifecycleRecordV2 } from "./lifecycle-v2.ts";
import { analyzeModelEvents, combineModelEvents } from "./model-events.ts";
import { deriveTurns, entryTimestampMilliseconds } from "./range.ts";
import type {
  ChildCoverage,
  ChildTimeline,
  InternalTurn,
  SubagentIssue,
  SubagentIssueCode,
  SubagentMetrics,
  TaskEfficiencyDependencies,
} from "./report-types.ts";
import { loadSourceSnapshot } from "./session.ts";
import { analyzeTools, combineToolAnalyses, extractToolCalls, type ToolAnalysis } from "./tool-metrics.ts";
import { analyzeUsage, combineUsage, restrictUsageCoverage, type UsageAnalysis } from "./usage-metrics.ts";
import type { SnapshotEntry, SourceSnapshot } from "./types.ts";

interface ParentCall {
  readonly toolCallId: string;
  readonly kind: "fresh" | "resume";
  readonly resumeId: string | null;
  readonly isBackground: boolean;
  readonly entry: SnapshotEntry;
}

interface ChildSource {
  readonly path: string;
  readonly snapshot: SourceSnapshot;
}

interface ChildWindowAnalysis {
  readonly usageAnalyses: readonly UsageAnalysis[];
  readonly toolAnalyses: readonly ToolAnalysis[];
  readonly modelEventMetrics: readonly ReturnType<typeof analyzeModelEvents>[];
  readonly childIntervals: readonly Interval[];
  readonly childWorkIntervals: readonly Interval[];
  readonly settled: boolean;
  readonly windowsComplete: boolean;
}

export async function analyzeSubagents(
  parent: SourceSnapshot,
  entries: readonly SnapshotEntry[],
  parentIntervals: readonly Interval[],
  dependencies: TaskEfficiencyDependencies,
): Promise<SubagentMetrics | null> {
  const calls = parentCalls(entries);
  const lifecycleEntries = lifecycleEntriesForTask(parent.activeBranch, calls, parentIntervals);
  if (calls.length === 0 && lifecycleEntries.length === 0) return null;

  const issues = new Set<SubagentIssueCode>();
  const validRecords: LifecycleRecordV2[] = [];
  for (const lifecycleEntry of lifecycleEntries) {
    const parsed = parseLifecycleRecordV2(lifecycleEntry.raw.data);
    if (parsed.record !== null) validRecords.push(parsed.record);
    else issues.add(parsed.unsupported ? "unsupported_lifecycle_version" : "invalid_lifecycle_record");
  }

  const selected = selectInvocations(calls, validRecords, parentIntervals, issues);
  validateStableIdentity(selected.records, issues);
  const expectedSessionIds = unique(selected.records
    .filter((record) => record.sessionState === "created")
    .map((record) => record.sessionId!));
  const childSources = await discoverChildren(parent, expectedSessionIds.length > 0, dependencies, issues);
  const childIndex = indexChildren(childSources, parent.sessionId, issues);
  const windows = analyzeChildWindows(selected.records, childIndex, issues);
  const rawChildUsage = combineUsage(windows.usageAnalyses);
  const coverage = buildCoverage(selected, rawChildUsage, windows, issues);
  const childUsage = restrictUsageCoverage(rawChildUsage, {
    usageComplete: coverage.usageComplete,
    costComplete: coverage.costComplete,
    reasoningComplete: coverage.usageComplete,
  });
  const transcriptComplete = childTranscriptComplete(coverage);
  const timeline = buildTimeline(parentIntervals, entries, calls, windows, coverage);

  return deepFreeze({
    invocations: calls.length + selected.serviceRecords.length,
    sessions: expectedSessionIds.length,
    fresh: calls.filter((call) => call.kind === "fresh").length + selected.serviceRecords.length,
    resumes: calls.filter((call) => call.kind === "resume").length,
    notCreated: selected.records.filter((record) => record.sessionState === "not-created").length,
    timeline,
    usage: childUsage.aggregation,
    tools: transcriptComplete ? combineToolAnalyses(windows.toolAnalyses).metrics : null,
    modelEvents: transcriptComplete ? combineModelEvents(windows.modelEventMetrics) : null,
    issues: [...issues].sort().map((code) => ({ code })),
    coverage,
  });
}

function parentCalls(entries: readonly SnapshotEntry[]): readonly ParentCall[] {
  return Object.freeze(extractToolCalls(entries)
    .filter((call) => call.name === "subagent")
    .map((call) => {
      const resumeId = nonEmptyString(call.arguments.resume) ? call.arguments.resume : null;
      return {
        toolCallId: call.id,
        kind: resumeId === null ? "fresh" as const : "resume" as const,
        resumeId,
        isBackground: call.arguments.run_in_background === true,
        entry: call.entry,
      };
    }));
}

function lifecycleEntriesForTask(
  entries: readonly SnapshotEntry[],
  calls: readonly ParentCall[],
  intervals: readonly Interval[],
): readonly SnapshotEntry[] {
  const callIds = new Set(calls.map((call) => call.toolCallId));
  return Object.freeze(entries.filter((entry) => {
    const raw = entry.raw as Record<string, unknown>;
    if (entry.type !== "custom" || raw.customType !== "subagents:record" || !isRecord(raw.data)) {
      return false;
    }
    if (typeof raw.data.toolCallId === "string" && callIds.has(raw.data.toolCallId)) return true;
    return raw.data.invocationSource === "service"
      && typeof raw.data.startedAt === "number"
      && Number.isFinite(raw.data.startedAt)
      && withinIntervals(raw.data.startedAt, intervals);
  }));
}

function selectInvocations(
  calls: readonly ParentCall[],
  records: readonly LifecycleRecordV2[],
  intervals: readonly Interval[],
  issues: Set<SubagentIssueCode>,
): { records: readonly LifecycleRecordV2[]; serviceRecords: readonly LifecycleRecordV2[]; workflowComplete: boolean } {
  let workflowComplete = true;
  const callIds = new Set<string>();
  for (const call of calls) {
    if (callIds.has(call.toolCallId)) {
      issues.add("duplicate_tool_call_id");
      workflowComplete = false;
    }
    callIds.add(call.toolCallId);
  }
  const byToolCall = group(records.filter((record) => record.invocationSource === "tool"), (record) => record.toolCallId!);
  const selected: LifecycleRecordV2[] = [];
  for (const call of calls) {
    const matching = byToolCall.get(call.toolCallId) ?? [];
    if (matching.length !== 1) {
      issues.add("missing_lifecycle_record");
      workflowComplete = false;
      continue;
    }
    const record = matching[0];
    if (record.invocationKind !== call.kind) {
      issues.add("lifecycle_kind_mismatch");
      workflowComplete = false;
      continue;
    }
    if (call.kind === "resume" && record.id !== call.resumeId) {
      issues.add("resume_identity_mismatch");
      workflowComplete = false;
      continue;
    }
    selected.push(record);
  }
  const serviceRecords = records.filter((record) => (
    record.invocationSource === "service" && withinIntervals(record.startedAt, intervals)
  ));
  selected.push(...serviceRecords);
  const selectedSet = new Set(selected);
  for (const record of records) {
    if (record.invocationSource === "tool" && !selectedSet.has(record)) {
      issues.add("unmatched_lifecycle_record");
      workflowComplete = false;
    }
  }
  return { records: Object.freeze(selected), serviceRecords: Object.freeze(serviceRecords), workflowComplete };
}

async function discoverChildren(
  parent: SourceSnapshot,
  needed: boolean,
  dependencies: TaskEfficiencyDependencies,
  issues: Set<SubagentIssueCode>,
): Promise<readonly ChildSource[]> {
  if (!needed) return Object.freeze([]);
  const directory = childDirectory(parent.sourcePath);
  let paths: readonly string[];
  try {
    paths = dependencies.readChildDirectory === undefined
      ? await defaultReadChildDirectory(directory)
      : await dependencies.readChildDirectory(directory);
  } catch {
    issues.add("child_discovery_failed");
    return Object.freeze([]);
  }
  const loader = dependencies.loadChildSnapshot ?? loadSourceSnapshot;
  const children: ChildSource[] = [];
  for (const childPath of paths.slice().sort()) {
    if (!childPath.endsWith(".jsonl")) continue;
    try {
      children.push({ path: childPath, snapshot: await loader(childPath) });
    } catch {
      issues.add("child_parse_failed");
    }
  }
  return Object.freeze(children);
}

function indexChildren(
  children: readonly ChildSource[],
  parentSessionId: string,
  issues: Set<SubagentIssueCode>,
): ReadonlyMap<string, readonly ChildSource[]> {
  const byId = new Map<string, ChildSource[]>();
  for (const child of children) {
    if (child.snapshot.parentSessionId !== parentSessionId) {
      issues.add("child_parent_mismatch");
      continue;
    }
    const sameId = byId.get(child.snapshot.sessionId) ?? [];
    sameId.push(child);
    byId.set(child.snapshot.sessionId, sameId);
  }
  for (const candidates of byId.values()) {
    if (candidates.length > 1) issues.add("duplicate_child_session");
  }
  return byId;
}

function analyzeChildWindows(
  records: readonly LifecycleRecordV2[],
  children: ReadonlyMap<string, readonly ChildSource[]>,
  issues: Set<SubagentIssueCode>,
): ChildWindowAnalysis {
  const bySession = group(records.filter((record) => record.sessionState === "created"), (record) => record.sessionId!);
  const usageAnalyses: UsageAnalysis[] = [];
  const toolAnalyses: ToolAnalysis[] = [];
  const modelEventMetrics: ReturnType<typeof analyzeModelEvents>[] = [];
  const childIntervals: Interval[] = [];
  const childWorkIntervals: Interval[] = [];
  let settled = true;
  let windowsComplete = true;
  for (const [sessionId, sessionRecords] of bySession) {
    const candidates = children.get(sessionId) ?? [];
    if (candidates.length !== 1) {
      issues.add("missing_child_session");
      settled = false;
      windowsComplete = false;
      continue;
    }
    const child = candidates[0];
    if (sessionRecords.some((record) => record.outputFile !== null && path.resolve(record.outputFile) !== path.resolve(child.path))) {
      issues.add("output_file_conflict");
    }
    if (hasOverlappingWindows(sessionRecords)) {
      issues.add("overlapping_invocation_windows");
      settled = false;
      windowsComplete = false;
    }
    const turns = deriveTurns(child.snapshot.activeBranch);
    const owners = new Map<string, LifecycleRecordV2>();
    const selectedTurns = new Map<string, InternalTurn>();
    for (const record of sessionRecords) {
      const matching = turns.filter((turn) => intersectsTurn(turn, record));
      if (matching.length === 0) {
        issues.add("empty_child_window");
        settled = false;
        windowsComplete = false;
      }
      const invocationEntries = matching.flatMap((turn) => turn.entries);
      const assistantUsage = analyzeUsage(invocationEntries.filter(isAssistantEntry));
      const tools = analyzeTools(invocationEntries);
      if (assistantUsage.usageComplete && !matchesInvocationUsage(record, assistantUsage)) {
        issues.add("invocation_usage_mismatch");
        windowsComplete = false;
      }
      if (record.invocationToolUses !== tools.metrics.calls) {
        issues.add("invocation_tool_count_mismatch");
        windowsComplete = false;
      }
      for (const turn of matching) {
        const owner = owners.get(turn.userEntryId);
        if (owner !== undefined && owner !== record) {
          issues.add("multiply_owned_child_turn");
          settled = false;
          windowsComplete = false;
        }
        owners.set(turn.userEntryId, record);
        selectedTurns.set(turn.userEntryId, turn);
      }
    }
    const selected = [...selectedTurns.values()].sort((left, right) => left.startIndex - right.startIndex);
    if (selected.some((turn) => !turn.settled)) {
      issues.add("unsettled_child_turn");
      settled = false;
    }
    const selectedEntries = selected.flatMap((turn) => turn.entries);
    usageAnalyses.push(analyzeUsage(selectedEntries));
    toolAnalyses.push(analyzeTools(selectedEntries));
    modelEventMetrics.push(analyzeModelEvents(selected));
    const intervals = selected.flatMap(turnInterval);
    childIntervals.push(...intervals);
    childWorkIntervals.push(...intervals);
  }
  return {
    usageAnalyses: Object.freeze(usageAnalyses),
    toolAnalyses: Object.freeze(toolAnalyses),
    modelEventMetrics: Object.freeze(modelEventMetrics),
    childIntervals: Object.freeze(childIntervals),
    childWorkIntervals: Object.freeze(childWorkIntervals),
    settled,
    windowsComplete,
  };
}

function buildCoverage(
  selected: { records: readonly LifecycleRecordV2[]; workflowComplete: boolean },
  childUsage: UsageAnalysis,
  windows: Pick<ChildWindowAnalysis, "settled" | "windowsComplete">,
  issues: ReadonlySet<SubagentIssueCode>,
): ChildCoverage {
  const discoveryComplete = !hasAny(issues, ["child_discovery_failed", "child_parse_failed", "child_parent_mismatch", "duplicate_child_session", "missing_child_session"]);
  const identityAttributionComplete = !hasAny(issues, [
    "invalid_lifecycle_record", "unsupported_lifecycle_version", "duplicate_tool_call_id",
    "duplicate_invocation_identity", "conflicting_agent_identity", "duplicate_child_session",
    "missing_child_session", "output_file_conflict", "child_parent_mismatch", "missing_lifecycle_record",
  ]);
  const workflowAttributionComplete = selected.workflowComplete && !hasAny(issues, [
    "invalid_lifecycle_record", "unsupported_lifecycle_version", "duplicate_tool_call_id",
    "missing_lifecycle_record", "unmatched_lifecycle_record", "lifecycle_kind_mismatch", "resume_identity_mismatch",
  ]);
  const childSessionsSettled = windows.settled && !hasAny(issues, [
    "overlapping_invocation_windows", "multiply_owned_child_turn", "empty_child_window", "unsettled_child_turn",
  ]);
  const usageComplete = discoveryComplete && identityAttributionComplete && workflowAttributionComplete
    && childSessionsSettled && windows.windowsComplete && childUsage.usageComplete;
  const costComplete = discoveryComplete && identityAttributionComplete && workflowAttributionComplete
    && childSessionsSettled && windows.windowsComplete && childUsage.costComplete;
  return deepFreeze({
    discoveryComplete,
    identityAttributionComplete,
    workflowAttributionComplete,
    childSessionsSettled,
    usageComplete,
    costComplete,
    complete: discoveryComplete && identityAttributionComplete && workflowAttributionComplete
      && childSessionsSettled && usageComplete && costComplete,
  });
}

function childTranscriptComplete(coverage: ChildCoverage): boolean {
  return coverage.discoveryComplete
    && coverage.identityAttributionComplete
    && coverage.workflowAttributionComplete
    && coverage.childSessionsSettled;
}

function buildTimeline(
  parentIntervals: readonly Interval[],
  entries: readonly SnapshotEntry[],
  calls: readonly ParentCall[],
  windows: Pick<ChildWindowAnalysis, "childIntervals" | "childWorkIntervals">,
  coverage: ChildCoverage,
): ChildTimeline {
  if (!coverage.discoveryComplete || !coverage.identityAttributionComplete
    || !coverage.workflowAttributionComplete || !coverage.childSessionsSettled) {
    return nullTimeline();
  }
  const parentActiveSeconds = intervalSeconds(parentIntervals);
  const childActiveSeconds = intervalSeconds(windows.childIntervals);
  const childWorkSeconds = windows.childWorkIntervals.reduce((total, interval) => total + intervalSeconds([interval]), 0);
  const workflowCriticalPathSeconds = intervalSeconds([...parentIntervals, ...windows.childIntervals]);
  const parentChildOverlapSeconds = overlapSeconds(parentIntervals, windows.childIntervals);
  const waits = subagentWaits(entries, calls, windows.childIntervals);
  return deepFreeze({
    parentActiveSeconds,
    childActiveSeconds,
    childWorkSeconds: Number(childWorkSeconds.toFixed(3)),
    parentChildOverlapSeconds,
    childParallelSeconds: Number(Math.max(0, childWorkSeconds - childActiveSeconds).toFixed(3)),
    workflowCriticalPathSeconds,
    overlappedAgentSeconds: Number(Math.max(0, parentActiveSeconds + childWorkSeconds - workflowCriticalPathSeconds).toFixed(3)),
    subagentWaitSeconds: waits.total,
    foregroundSubagentSeconds: waits.foreground,
    resultWaitSeconds: waits.result,
    waitDuringChildSeconds: overlapSeconds(waits.intervals, windows.childIntervals),
  });
}

function subagentWaits(entries: readonly SnapshotEntry[], calls: readonly ParentCall[], childIntervals: readonly Interval[]) {
  const results = toolResultTimes(entries);
  const foreground: Interval[] = [];
  const result: Interval[] = [];
  for (const call of calls) {
    if (call.isBackground) continue;
    const end = results.get(call.toolCallId);
    const start = entryTimestampMilliseconds(call.entry);
    if (start !== null && end !== undefined && end >= start) foreground.push([start, end]);
  }
  for (const call of extractToolCalls(entries)) {
    if (call.name !== "get_subagent_result" || call.arguments.wait !== true) continue;
    const start = entryTimestampMilliseconds(call.entry);
    const end = results.get(call.id);
    if (start !== null && end !== undefined && end >= start) result.push([start, end]);
  }
  const intervals = [...foreground, ...result];
  return {
    intervals,
    foreground: intervalSeconds(foreground),
    result: intervalSeconds(result),
    total: intervalSeconds(intervals),
    childOverlap: overlapSeconds(intervals, childIntervals),
  };
}

function toolResultTimes(entries: readonly SnapshotEntry[]): ReadonlyMap<string, number> {
  const grouped = new Map<string, number[]>();
  for (const entry of entries) {
    const raw = entry.raw as Record<string, unknown>;
    if (entry.type !== "message" || !isRecord(raw.message) || raw.message.role !== "toolResult"
      || typeof raw.message.toolCallId !== "string") continue;
    const timestamp = entryTimestampMilliseconds(entry);
    if (timestamp === null) continue;
    const values = grouped.get(raw.message.toolCallId) ?? [];
    values.push(timestamp);
    grouped.set(raw.message.toolCallId, values);
  }
  return new Map([...grouped].filter(([, values]) => values.length === 1).map(([id, values]) => [id, values[0]]));
}

function validateStableIdentity(records: readonly LifecycleRecordV2[], issues: Set<SubagentIssueCode>): void {
  if (hasDuplicate(records.map((record) => `${record.id}:${record.invocationIndex}`))) {
    issues.add("duplicate_invocation_identity");
  }
  const byAgent = group(records, (record) => record.id);
  for (const agentRecords of byAgent.values()) {
    const sessions = new Set(agentRecords.filter((record) => record.sessionId !== null).map((record) => record.sessionId));
    const types = new Set(agentRecords.map((record) => record.type));
    if (sessions.size > 1 || types.size > 1) issues.add("conflicting_agent_identity");
  }
  const bySession = group(records.filter((record) => record.sessionId !== null), (record) => record.sessionId!);
  for (const sessionRecords of bySession.values()) {
    if (new Set(sessionRecords.map((record) => record.id)).size > 1) issues.add("conflicting_agent_identity");
  }
}

function matchesInvocationUsage(record: LifecycleRecordV2, analysis: UsageAnalysis): boolean {
  const tokens = analysis.aggregation.tokens;
  return analysis.usageComplete
    && tokens.input === record.invocationUsage.input
    && tokens.output === record.invocationUsage.output
    && tokens.cacheWrite === record.invocationUsage.cacheWrite;
}

function hasOverlappingWindows(records: readonly LifecycleRecordV2[]): boolean {
  const ordered = records.slice().sort((left, right) => left.startedAt - right.startedAt);
  return ordered.some((record, index) => index > 0 && record.startedAt < ordered[index - 1].completedAt);
}

function intersectsTurn(turn: InternalTurn, record: LifecycleRecordV2): boolean {
  const start = parseTurnTimestamp(turn.startTimestamp);
  const end = parseTurnTimestamp(turn.endTimestamp);
  return start !== null && end !== null && start <= record.completedAt && end >= record.startedAt;
}

function turnInterval(turn: InternalTurn): readonly Interval[] {
  const start = parseTurnTimestamp(turn.startTimestamp);
  const end = parseTurnTimestamp(turn.endTimestamp);
  return start === null || end === null || end < start ? [] : [[start, end]];
}

function childDirectory(sourcePath: string): string {
  const extension = path.extname(sourcePath) === ".jsonl" ? ".jsonl" : "";
  return path.join(path.dirname(sourcePath), path.basename(sourcePath, extension), "tasks");
}

async function defaultReadChildDirectory(directory: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(directory, entry.name)).sort();
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function withinIntervals(timestamp: number, intervals: readonly Interval[]): boolean {
  return intervals.some(([start, end]) => timestamp >= start && timestamp <= end);
}

function group<T>(items: readonly T[], key: (item: T) => string): ReadonlyMap<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const values = grouped.get(key(item)) ?? [];
    values.push(item);
    grouped.set(key(item), values);
  }
  return grouped;
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

function hasDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function hasAny(issues: ReadonlySet<SubagentIssueCode>, codes: readonly SubagentIssueCode[]): boolean {
  return codes.some((code) => issues.has(code));
}

function parseTurnTimestamp(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function isAssistantEntry(entry: SnapshotEntry): boolean {
  const raw = entry.raw as Record<string, unknown>;
  return entry.type === "message" && isRecord(raw.message) && raw.message.role === "assistant";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullTimeline(): ChildTimeline {
  return deepFreeze({
    parentActiveSeconds: null,
    childActiveSeconds: null,
    childWorkSeconds: null,
    parentChildOverlapSeconds: null,
    childParallelSeconds: null,
    workflowCriticalPathSeconds: null,
    overlappedAgentSeconds: null,
    subagentWaitSeconds: null,
    foregroundSubagentSeconds: null,
    resultWaitSeconds: null,
    waitDuringChildSeconds: null,
  });
}
