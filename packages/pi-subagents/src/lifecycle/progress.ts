import type { SubagentPhase } from "#src/lifecycle/subagent-state";

/** Observed live status; absent timestamps never imply a stalled task. */
export interface SubagentProgress {
  activity: string;
  invocationTurnCount: number;
  maxTurns: number;
  lastProgressAt?: number;
  sinceLastProgressMs?: number;
}

export interface ProgressSource {
  phase: SubagentPhase;
  invocationTurnCount: number;
  maxTurns: number;
  activeTools: ReadonlyMap<string, string>;
  responseText: string;
  observedActivity?: "model" | "response" | "tool" | "compacting";
  lastProgressAt?: number;
}

/** One projection for foreground updates, result queries, service and widget. */
export function getSubagentProgress(source: ProgressSource, now = Date.now()): SubagentProgress {
  let activity: string;
  if (source.phase === "queued") activity = "Queued";
  else if (source.phase === "terminal") activity = "Terminal state";
  else if (source.activeTools.size) activity = `Running tools: ${[...source.activeTools.values()].join(", ")}`;
  else if (source.observedActivity === "compacting") activity = "Compacting context";
  else if (source.observedActivity === "model") activity = "Model turn in progress";
  else if (source.observedActivity === "tool") activity = "Tool activity observed";
  else if (source.observedActivity === "response" || source.responseText) activity = "Writing response";
  else activity = "Running; no activity observed yet";
  return {
    activity,
    invocationTurnCount: source.invocationTurnCount,
    maxTurns: source.maxTurns,
    ...(source.lastProgressAt === undefined ? {} : {
      lastProgressAt: source.lastProgressAt,
      sinceLastProgressMs: Math.max(0, now - source.lastProgressAt),
    }),
  };
}
