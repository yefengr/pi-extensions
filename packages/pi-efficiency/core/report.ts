import { deepFreeze } from "./freeze.ts";
import { analyzeModelEvents } from "./model-events.ts";
import { deriveTurns, selectedRangeEntries } from "./range.ts";
import type {
  TaskEfficiencyDependencies,
  TaskEfficiencyReport,
  ValidatedTaskRange,
} from "./report-types.ts";
import { analyzeSubagents } from "./subagent-report.ts";
import { analyzeTime } from "./time-metrics.ts";
import { analyzeTools } from "./tool-metrics.ts";
import { analyzeUsage, combineUsage } from "./usage-metrics.ts";
import type { SourceSnapshot } from "./types.ts";

export async function buildTaskEfficiencyReport(
  snapshot: SourceSnapshot,
  range: ValidatedTaskRange,
  dependencies: TaskEfficiencyDependencies = {},
): Promise<TaskEfficiencyReport> {
  const entries = selectedRangeEntries(snapshot, range);
  const turns = deriveTurns(entries, range.startIndex);
  const tools = analyzeTools(entries);
  const time = analyzeTime(turns, tools.metrics.criticalPathSeconds);
  const parentUsage = analyzeUsage(entries);
  const modelEvents = analyzeModelEvents(turns);
  const subagents = await analyzeSubagents(snapshot, entries, time.parentIntervals, dependencies);
  const childUsage = subagents === null ? null : usageAnalysisFromSubagents(subagents);
  const combined = childUsage === null ? parentUsage : combineUsage([parentUsage, childUsage]);
  const childToolTimingComplete = subagents === null || (subagents.tools !== null
    && subagents.tools.batchWaitSeconds !== null
    && subagents.tools.criticalPathSeconds !== null
    && subagents.tools.longestCallSeconds !== null);
  const toolTimingComplete = tools.timingComplete && childToolTimingComplete;
  const modelEventsComplete = subagents === null || subagents.modelEvents !== null;
  const coverage = {
    sessionComplete: true as const,
    rangeComplete: true as const,
    timeComplete: time.timeComplete,
    usageComplete: combined.usageComplete,
    costComplete: combined.costComplete,
    reasoningComplete: combined.reasoningComplete,
    toolTimingComplete,
    modelEventsComplete,
    subagents: subagents?.coverage ?? null,
    complete: time.timeComplete
      && combined.usageComplete
      && combined.costComplete
      && toolTimingComplete
      && modelEventsComplete
      && (subagents?.coverage.complete ?? true),
  };
  return deepFreeze({
    schemaVersion: 1,
    source: {
      sessionId: snapshot.sessionId,
      digest: snapshot.digest,
      activeLeafId: snapshot.activeLeafId,
    },
    range: {
      startEntryId: range.startEntryId,
      endEntryId: range.endEntryId,
      startTimestamp: turns[0]?.startTimestamp ?? null,
      endTimestamp: turns.at(-1)?.endTimestamp ?? null,
      entryCount: entries.length,
      turns: turns.map((turn) => ({
        userEntryId: turn.userEntryId,
        startTimestamp: turn.startTimestamp,
        endTimestamp: turn.endTimestamp,
        status: turn.status,
        stopReason: turn.stopReason,
        settled: turn.settled,
      })),
    },
    time: time.metrics,
    usage: {
      parent: parentUsage.aggregation,
      children: subagents?.usage ?? null,
      combined: combined.aggregation,
    },
    tools: tools.metrics,
    modelEvents,
    subagents,
    coverage,
  });
}

function usageAnalysisFromSubagents(subagents: NonNullable<Awaited<ReturnType<typeof analyzeSubagents>>>) {
  return {
    aggregation: subagents.usage,
    usageComplete: subagents.coverage.usageComplete,
    costComplete: subagents.coverage.costComplete,
    reasoningComplete: subagents.coverage.usageComplete
      && subagents.usage.tokens.reasoning !== null,
  };
}
