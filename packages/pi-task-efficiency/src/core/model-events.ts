import { deepFreeze } from "./freeze.ts";
import type { InternalTurn, ModelByName, ModelEventMetrics, ModelStatusCounts } from "./report-types.ts";

interface MutableStatuses {
  completed: number;
  toolUse: number;
  failed: number;
  truncated: number;
  aborted: number;
  other: number;
}

interface MutableModelGroup {
  responses: number;
  failures: number;
  automaticRetries: number;
  statuses: MutableStatuses;
}

interface MutableSummary {
  responses: number;
  failures: number;
  automaticRetries: number;
  turnsWithFailures: number;
  recoveredTurns: number;
  failedTurns: number;
  statuses: MutableStatuses;
  byModel: Record<string, MutableModelGroup>;
}

export function analyzeModelEvents(turns: readonly InternalTurn[]): ModelEventMetrics {
  const summary = createSummary();
  for (const turn of turns) analyzeTurn(summary, turn);
  return freezeSummary(summary);
}

export function combineModelEvents(metrics: readonly ModelEventMetrics[]): ModelEventMetrics {
  const summary = createSummary();
  for (const metric of metrics) {
    summary.responses += metric.responses;
    summary.failures += metric.failures;
    summary.automaticRetries += metric.automaticRetries;
    summary.turnsWithFailures += metric.turnsWithFailures;
    summary.recoveredTurns += metric.recoveredTurns;
    summary.failedTurns += metric.failedTurns;
    addStatuses(summary.statuses, metric.statuses);
    for (const key of Object.keys(metric.byModel).sort()) {
      const values = metric.byModel[key];
      const group = summary.byModel[key] ?? createModelGroup();
      group.responses += values.responses;
      group.failures += values.failures;
      group.automaticRetries += values.automaticRetries;
      addStatuses(group.statuses, values.statuses);
      summary.byModel[key] = group;
    }
  }
  return freezeSummary(summary);
}

function analyzeTurn(summary: MutableSummary, turn: InternalTurn): void {
  let hadFailure = false;
  let retryPending = false;
  let lastStopReason: string | null = null;
  for (const entry of turn.entries) {
    const raw = entry.raw as Record<string, unknown>;
    if (entry.type !== "message" || !isRecord(raw.message) || raw.message.role !== "assistant") continue;
    const message = raw.message;
    const group = summary.byModel[modelKey(message)] ?? createModelGroup();
    const reason = typeof message.stopReason === "string" ? message.stopReason : null;
    summary.responses += 1;
    group.responses += 1;
    incrementStatus(summary.statuses, reason);
    incrementStatus(group.statuses, reason);
    if (retryPending) {
      summary.automaticRetries += 1;
      group.automaticRetries += 1;
    }
    if (reason === "error") {
      summary.failures += 1;
      group.failures += 1;
      hadFailure = true;
    }
    retryPending = reason === "error";
    lastStopReason = reason;
    summary.byModel[modelKey(message)] = group;
  }
  if (!hadFailure) return;
  summary.turnsWithFailures += 1;
  if (lastStopReason === "error") summary.failedTurns += 1;
  else summary.recoveredTurns += 1;
}

function freezeSummary(summary: MutableSummary): ModelEventMetrics {
  const byModel: Record<string, ModelByName> = {};
  for (const key of Object.keys(summary.byModel).sort()) {
    const group = summary.byModel[key];
    byModel[key] = { ...group, statuses: { ...group.statuses } };
  }
  return deepFreeze({
    ...summary,
    statuses: { ...summary.statuses },
    byModel,
  });
}

function addStatuses(target: MutableStatuses, addition: ModelStatusCounts): void {
  target.completed += addition.completed;
  target.toolUse += addition.toolUse;
  target.failed += addition.failed;
  target.truncated += addition.truncated;
  target.aborted += addition.aborted;
  target.other += addition.other;
}

function createSummary(): MutableSummary {
  return {
    responses: 0,
    failures: 0,
    automaticRetries: 0,
    turnsWithFailures: 0,
    recoveredTurns: 0,
    failedTurns: 0,
    statuses: zeroStatuses(),
    byModel: {},
  };
}

function createModelGroup(): MutableModelGroup {
  return { responses: 0, failures: 0, automaticRetries: 0, statuses: zeroStatuses() };
}

function zeroStatuses(): MutableStatuses {
  return { completed: 0, toolUse: 0, failed: 0, truncated: 0, aborted: 0, other: 0 };
}

function incrementStatus(statuses: MutableStatuses, reason: string | null): void {
  switch (reason) {
    case "stop": statuses.completed += 1; break;
    case "toolUse": statuses.toolUse += 1; break;
    case "error": statuses.failed += 1; break;
    case "length": statuses.truncated += 1; break;
    case "aborted": statuses.aborted += 1; break;
    default: statuses.other += 1;
  }
}

function modelKey(message: Record<string, unknown>): string {
  const provider = typeof message.provider === "string" ? message.provider : "unknown-provider";
  const model = typeof message.responseModel === "string" && message.responseModel.length > 0
    ? message.responseModel
    : typeof message.model === "string" ? message.model : "unknown-model";
  return `${provider}:${model}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
