import { intervalSeconds, type Interval } from "./intervals.ts";
import type { InternalTurn, TimeMetrics } from "./report-types.ts";

export interface TimeAnalysis {
  readonly metrics: TimeMetrics;
  readonly timeComplete: boolean;
  readonly parentIntervals: readonly Interval[];
}

export function analyzeTime(
  turns: readonly InternalTurn[],
  toolCriticalPathSeconds: number | null,
): TimeAnalysis {
  const intervals: Interval[] = [];
  let timeComplete = turns.length > 0;
  let userWaitMilliseconds = 0;
  let previousEnd: number | null = null;
  for (const turn of turns) {
    const start = parseIso(turn.startTimestamp);
    const end = parseIso(turn.endTimestamp);
    if (start === null || end === null || end < start) {
      timeComplete = false;
      continue;
    }
    intervals.push([start, end]);
    if (previousEnd !== null) userWaitMilliseconds += Math.max(0, start - previousEnd);
    previousEnd = end;
  }
  const firstStart = parseIso(turns[0]?.startTimestamp ?? null);
  const finalEnd = parseIso(turns.at(-1)?.endTimestamp ?? null);
  if (firstStart === null || finalEnd === null || finalEnd < firstStart) timeComplete = false;
  const active = timeComplete ? intervalSeconds(intervals) : null;
  const wallClock = timeComplete ? seconds(finalEnd! - firstStart!) : null;
  const userWait = timeComplete ? seconds(userWaitMilliseconds) : null;
  const nonTool = active !== null && toolCriticalPathSeconds !== null
    ? Number(Math.max(0, active - toolCriticalPathSeconds).toFixed(3))
    : null;
  return Object.freeze({
    metrics: Object.freeze({
      wallClockSpanSeconds: wallClock,
      userWaitSeconds: userWait,
      agentActiveSeconds: active,
      toolCriticalPathSeconds,
      nonToolActiveSeconds: nonTool,
    }),
    timeComplete,
    parentIntervals: Object.freeze(intervals),
  });
}

function parseIso(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function seconds(milliseconds: number): number {
  return Number((Math.max(0, milliseconds) / 1000).toFixed(3));
}
