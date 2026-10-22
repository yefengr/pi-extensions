import { deepFreeze } from "./freeze.ts";
import { type Interval, intervalSeconds } from "./intervals.ts";
import { entryTimestampMilliseconds } from "./range.ts";
import type { ToolMetrics } from "./report-types.ts";
import type { SnapshotEntry } from "./types.ts";

export interface ExtractedToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly entry: SnapshotEntry;
}

interface ExtractedToolResult {
  readonly id: string;
  readonly isError: boolean;
  readonly entry: SnapshotEntry;
}

export interface ToolAnalysis {
  readonly metrics: ToolMetrics;
  readonly timingComplete: boolean;
  readonly batchIntervals: readonly Interval[];
  readonly batchWaitMilliseconds: number;
  readonly longestCallMilliseconds: number;
}

export function analyzeTools(entries: readonly SnapshotEntry[]): ToolAnalysis {
  const calls = extractToolCalls(entries);
  const results = extractToolResults(entries);
  const batches = callBatches(entries);
  const callsById = groupById(calls);
  const resultsById = groupById(results);
  const byTool: Record<string, { calls: number; failures: number; incompleteCalls: number }> = {};
  const batchIntervals: Interval[] = [];
  let failures = 0;
  let incompleteCalls = 0;
  let orphanResults = 0;
  let batchWaitMilliseconds = 0;
  let longestCallMilliseconds = 0;
  let timingComplete = true;

  for (const result of results) {
    if (!hasUniquePair(result.id, callsById, resultsById)) {
      orphanResults += 1;
      timingComplete = false;
    }
  }

  for (const batch of batches) {
    const start = entryTimestampMilliseconds(batch.entry);
    const resultTimes: number[] = [];
    for (const call of batch.calls) {
      const group = byTool[call.name] ?? { calls: 0, failures: 0, incompleteCalls: 0 };
      group.calls += 1;
      if (!hasUniquePair(call.id, callsById, resultsById)) {
        group.incompleteCalls += 1;
        incompleteCalls += 1;
        timingComplete = false;
      } else {
        const result = resultsById.get(call.id)![0];
        if (result.isError) {
          failures += 1;
          group.failures += 1;
        }
        const end = entryTimestampMilliseconds(result.entry);
        if (start === null || end === null || end < start) {
          timingComplete = false;
        } else {
          resultTimes.push(end);
          longestCallMilliseconds = Math.max(longestCallMilliseconds, end - start);
        }
      }
      byTool[call.name] = group;
    }
    if (batch.calls.length > 0) {
      if (start === null || resultTimes.length !== batch.calls.length) {
        timingComplete = false;
      } else {
        const end = Math.max(...resultTimes);
        batchIntervals.push([start, end]);
        batchWaitMilliseconds += end - start;
      }
    }
  }

  return toolAnalysis({
    calls: calls.length,
    batches: batches.length,
    failures,
    incompleteCalls,
    orphanResults,
    byTool,
    batchIntervals,
    batchWaitMilliseconds,
    longestCallMilliseconds,
    timingComplete,
  });
}

export function combineToolAnalyses(analyses: readonly ToolAnalysis[]): ToolAnalysis {
  const byTool: Record<string, { calls: number; failures: number; incompleteCalls: number }> = {};
  const batchIntervals: Interval[] = [];
  let calls = 0;
  let batches = 0;
  let failures = 0;
  let incompleteCalls = 0;
  let orphanResults = 0;
  let batchWaitMilliseconds = 0;
  let longestCallMilliseconds = 0;
  let timingComplete = true;

  for (const analysis of analyses) {
    const metrics = analysis.metrics;
    calls += metrics.calls;
    batches += metrics.batches;
    failures += metrics.failures;
    incompleteCalls += metrics.incompleteCalls;
    orphanResults += metrics.orphanResults;
    batchWaitMilliseconds += analysis.batchWaitMilliseconds;
    longestCallMilliseconds = Math.max(longestCallMilliseconds, analysis.longestCallMilliseconds);
    batchIntervals.push(...analysis.batchIntervals);
    timingComplete &&= analysis.timingComplete;
    for (const [name, values] of Object.entries(metrics.byTool)) {
      const group = byTool[name] ?? { calls: 0, failures: 0, incompleteCalls: 0 };
      group.calls += values.calls;
      group.failures += values.failures;
      group.incompleteCalls += values.incompleteCalls;
      byTool[name] = group;
    }
  }

  return toolAnalysis({
    calls,
    batches,
    failures,
    incompleteCalls,
    orphanResults,
    byTool,
    batchIntervals,
    batchWaitMilliseconds,
    longestCallMilliseconds,
    timingComplete,
  });
}

export function extractToolCalls(entries: readonly SnapshotEntry[]): readonly ExtractedToolCall[] {
  const calls: ExtractedToolCall[] = [];
  for (const entry of entries) {
    const raw = entry.raw as Record<string, unknown>;
    if (entry.type !== "message" || !isRecord(raw.message) || raw.message.role !== "assistant") continue;
    if (!Array.isArray(raw.message.content)) continue;
    for (const value of raw.message.content) {
      if (!isRecord(value) || value.type !== "toolCall" || typeof value.id !== "string" || typeof value.name !== "string") continue;
      calls.push({
        id: value.id,
        name: value.name,
        arguments: isRecord(value.arguments) ? value.arguments : {},
        entry,
      });
    }
  }
  return Object.freeze(calls);
}

function extractToolResults(entries: readonly SnapshotEntry[]): readonly ExtractedToolResult[] {
  const results: ExtractedToolResult[] = [];
  for (const entry of entries) {
    const raw = entry.raw as Record<string, unknown>;
    if (entry.type !== "message" || !isRecord(raw.message) || raw.message.role !== "toolResult") continue;
    if (typeof raw.message.toolCallId !== "string") continue;
    results.push({ id: raw.message.toolCallId, isError: raw.message.isError === true, entry });
  }
  return Object.freeze(results);
}

function callBatches(entries: readonly SnapshotEntry[]): readonly { entry: SnapshotEntry; calls: readonly ExtractedToolCall[] }[] {
  const calls = extractToolCalls(entries);
  const byEntry = new Map<SnapshotEntry, ExtractedToolCall[]>();
  for (const call of calls) {
    const batch = byEntry.get(call.entry) ?? [];
    batch.push(call);
    byEntry.set(call.entry, batch);
  }
  return Object.freeze([...byEntry.entries()].map(([entry, batch]) => ({ entry, calls: Object.freeze(batch) })));
}

function toolAnalysis(values: {
  calls: number;
  batches: number;
  failures: number;
  incompleteCalls: number;
  orphanResults: number;
  byTool: Record<string, { calls: number; failures: number; incompleteCalls: number }>;
  batchIntervals: readonly Interval[];
  batchWaitMilliseconds: number;
  longestCallMilliseconds: number;
  timingComplete: boolean;
}): ToolAnalysis {
  return deepFreeze({
    metrics: {
      calls: values.calls,
      batches: values.batches,
      failures: values.failures,
      incompleteCalls: values.incompleteCalls,
      orphanResults: values.orphanResults,
      byTool: sortRecord(values.byTool),
      batchWaitSeconds: values.timingComplete ? millisecondsToSeconds(values.batchWaitMilliseconds) : null,
      criticalPathSeconds: values.timingComplete ? intervalSeconds(values.batchIntervals) : null,
      longestCallSeconds: values.timingComplete ? millisecondsToSeconds(values.longestCallMilliseconds) : null,
    },
    timingComplete: values.timingComplete,
    batchIntervals: values.batchIntervals.slice(),
    batchWaitMilliseconds: values.batchWaitMilliseconds,
    longestCallMilliseconds: values.longestCallMilliseconds,
  });
}

function hasUniquePair(
  id: string,
  callsById: ReadonlyMap<string, readonly ExtractedToolCall[]>,
  resultsById: ReadonlyMap<string, readonly ExtractedToolResult[]>,
): boolean {
  return (callsById.get(id)?.length ?? 0) === 1 && (resultsById.get(id)?.length ?? 0) === 1;
}

function groupById<T extends { id: string }>(items: readonly T[]): ReadonlyMap<string, readonly T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const group = grouped.get(item.id) ?? [];
    group.push(item);
    grouped.set(item.id, group);
  }
  return grouped;
}

function millisecondsToSeconds(milliseconds: number): number {
  return Number((Math.max(0, milliseconds) / 1000).toFixed(3));
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
