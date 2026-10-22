import { deepFreeze } from "./freeze.ts";
import type { CostTotals, TokenTotals, UsageAggregation, UsageByModel } from "./report-types.ts";
import type { SnapshotEntry } from "./types.ts";

type MutableTokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
};

type MutableCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

interface UsageState {
  events: number;
  usageComplete: boolean;
  costComplete: boolean;
  reasoningComplete: boolean;
  tokens: MutableTokens;
  cost: MutableCost;
}

interface UsageGroup extends UsageState {
  key: string;
}

export interface UsageAnalysis {
  readonly aggregation: UsageAggregation;
  readonly usageComplete: boolean;
  readonly costComplete: boolean;
  readonly reasoningComplete: boolean;
}

export function analyzeUsage(entries: readonly SnapshotEntry[]): UsageAnalysis {
  const total = createState();
  const groups = new Map<string, UsageGroup>();
  for (const entry of entries) {
    const source = usageSource(entry);
    if (source === null) continue;
    const group = groups.get(source.key) ?? createGroup(source.key);
    groups.set(source.key, group);
    total.events += 1;
    group.events += 1;
    applyUsage(total, source.usage, source.required);
    applyUsage(group, source.usage, source.required);
  }
  const byModel: Record<string, UsageByModel> = {};
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!;
    byModel[key] = toGroup(group);
  }
  return deepFreeze({
    aggregation: {
      events: total.events,
      tokens: toTokens(total),
      cost: toCost(total),
      costBasis: "pi_session_recorded",
      byModel,
    },
    usageComplete: total.usageComplete,
    costComplete: total.costComplete,
    reasoningComplete: total.reasoningComplete,
  });
}

export function combineUsage(analyses: readonly UsageAnalysis[]): UsageAnalysis {
  const total = createState();
  const groups = new Map<string, UsageGroup>();
  for (const analysis of analyses) {
    const aggregation = analysis.aggregation;
    total.events += aggregation.events;
    total.usageComplete &&= analysis.usageComplete;
    total.costComplete &&= analysis.costComplete;
    total.reasoningComplete &&= analysis.reasoningComplete;
    addTokenFacts(total.tokens, aggregation.tokens, analysis.usageComplete, analysis.reasoningComplete);
    addCostFacts(total.cost, aggregation.cost, analysis.costComplete);
    for (const [key, byModel] of Object.entries(aggregation.byModel)) {
      const group = groups.get(key) ?? createGroup(key);
      groups.set(key, group);
      group.events += byModel.events;
      const groupUsageComplete = tokenFactsPresent(byModel.tokens);
      const groupCostComplete = costFactsPresent(byModel.cost);
      const groupReasoningComplete = byModel.tokens.reasoning !== null;
      group.usageComplete &&= groupUsageComplete;
      group.costComplete &&= groupCostComplete;
      group.reasoningComplete &&= groupReasoningComplete;
      addTokenFacts(group.tokens, byModel.tokens, groupUsageComplete, groupReasoningComplete);
      addCostFacts(group.cost, byModel.cost, groupCostComplete);
    }
  }
  const byModel: Record<string, UsageByModel> = {};
  for (const key of [...groups.keys()].sort()) byModel[key] = toGroup(groups.get(key)!);
  return deepFreeze({
    aggregation: {
      events: total.events,
      tokens: toTokens(total),
      cost: toCost(total),
      costBasis: "pi_session_recorded",
      byModel,
    },
    usageComplete: total.usageComplete,
    costComplete: total.costComplete,
    reasoningComplete: total.reasoningComplete,
  });
}

export function restrictUsageCoverage(
  analysis: UsageAnalysis,
  coverage: { readonly usageComplete: boolean; readonly costComplete: boolean; readonly reasoningComplete: boolean },
): UsageAnalysis {
  const usageComplete = analysis.usageComplete && coverage.usageComplete;
  const costComplete = analysis.costComplete && coverage.costComplete;
  const reasoningComplete = analysis.reasoningComplete && coverage.reasoningComplete;
  const byModel: Record<string, UsageByModel> = {};
  for (const [key, group] of Object.entries(analysis.aggregation.byModel)) {
    byModel[key] = {
      ...group,
      tokens: usageComplete ? group.tokens : nullTokens(),
      cost: costComplete ? group.cost : nullCost(),
    };
  }
  return deepFreeze({
    aggregation: {
      ...analysis.aggregation,
      tokens: usageComplete ? analysis.aggregation.tokens : nullTokens(),
      cost: costComplete ? analysis.aggregation.cost : nullCost(),
      byModel,
    },
    usageComplete,
    costComplete,
    reasoningComplete,
  });
}

function usageSource(entry: SnapshotEntry): { key: string; usage: unknown; required: boolean } | null {
  const raw = entry.raw as Record<string, unknown>;
  if (entry.type === "message" && isRecord(raw.message)) {
    const message = raw.message;
    if (message.role === "assistant") return {
      key: modelKey(message),
      usage: message.usage,
      required: true,
    };
    if (message.role === "toolResult" && Object.hasOwn(message, "usage")) {
      return { key: "tools/summaries", usage: message.usage, required: false };
    }
  }
  if ((entry.type === "compaction" || entry.type === "branch_summary") && Object.hasOwn(raw, "usage")) {
    return { key: "tools/summaries", usage: raw.usage, required: false };
  }
  return null;
}

function applyUsage(state: UsageState, raw: unknown, required: boolean): void {
  const normalized = normalizeUsage(raw);
  if (!normalized.tokensValid) state.usageComplete = false;
  if (!normalized.costValid) state.costComplete = false;
  if (!normalized.reasoningValid) state.reasoningComplete = false;
  if (normalized.tokens !== null) addTokenValues(state.tokens, normalized.tokens);
  if (normalized.cost !== null) addCostValues(state.cost, normalized.cost);
  if (!required && raw === undefined) return;
}

function normalizeUsage(raw: unknown): {
  tokensValid: boolean;
  costValid: boolean;
  reasoningValid: boolean;
  tokens: MutableTokens | null;
  cost: MutableCost | null;
} {
  if (!isRecord(raw)) return {
    tokensValid: false,
    costValid: false,
    reasoningValid: false,
    tokens: null,
    cost: null,
  };
  const tokenFields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
  const tokensValid = tokenFields.every((field) => finiteNonNegative(raw[field]));
  const reasoningValid = finiteNonNegative(raw.reasoning);
  const costFields = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
  const costRecord = isRecord(raw.cost) ? raw.cost : null;
  const costValid = costRecord !== null && costFields.every((field) => finiteNonNegative(costRecord[field]));
  return {
    tokensValid,
    costValid,
    reasoningValid,
    tokens: tokensValid ? {
      input: raw.input as number,
      output: raw.output as number,
      cacheRead: raw.cacheRead as number,
      cacheWrite: raw.cacheWrite as number,
      reasoning: reasoningValid ? raw.reasoning as number : 0,
      totalTokens: raw.totalTokens as number,
    } : null,
    cost: costValid ? {
      input: costRecord!.input as number,
      output: costRecord!.output as number,
      cacheRead: costRecord!.cacheRead as number,
      cacheWrite: costRecord!.cacheWrite as number,
      total: costRecord!.total as number,
    } : null,
  };
}

function createState(): UsageState {
  return {
    events: 0,
    usageComplete: true,
    costComplete: true,
    reasoningComplete: true,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createGroup(key: string): UsageGroup {
  return { key, ...createState() };
}

function toTokens(state: UsageState): TokenTotals {
  return {
    input: state.usageComplete ? state.tokens.input : null,
    output: state.usageComplete ? state.tokens.output : null,
    cacheRead: state.usageComplete ? state.tokens.cacheRead : null,
    cacheWrite: state.usageComplete ? state.tokens.cacheWrite : null,
    reasoning: state.reasoningComplete ? state.tokens.reasoning : null,
    totalTokens: state.usageComplete ? state.tokens.totalTokens : null,
  };
}

function toCost(state: UsageState): CostTotals {
  return {
    input: state.costComplete ? state.cost.input : null,
    output: state.costComplete ? state.cost.output : null,
    cacheRead: state.costComplete ? state.cost.cacheRead : null,
    cacheWrite: state.costComplete ? state.cost.cacheWrite : null,
    total: state.costComplete ? state.cost.total : null,
  };
}

function nullTokens(): TokenTotals {
  return { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, totalTokens: null };
}

function nullCost(): CostTotals {
  return { input: null, output: null, cacheRead: null, cacheWrite: null, total: null };
}

function toGroup(group: UsageGroup): UsageByModel {
  return { events: group.events, tokens: toTokens(group), cost: toCost(group) };
}

function addTokenValues(target: MutableTokens, addition: MutableTokens): void {
  target.input += addition.input;
  target.output += addition.output;
  target.cacheRead += addition.cacheRead;
  target.cacheWrite += addition.cacheWrite;
  target.reasoning += addition.reasoning;
  target.totalTokens += addition.totalTokens;
}

function addCostValues(target: MutableCost, addition: MutableCost): void {
  target.input += addition.input;
  target.output += addition.output;
  target.cacheRead += addition.cacheRead;
  target.cacheWrite += addition.cacheWrite;
  target.total += addition.total;
}

function addTokenFacts(
  target: MutableTokens,
  addition: TokenTotals,
  usageComplete: boolean,
  reasoningComplete: boolean,
): void {
  if (usageComplete) {
    target.input += addition.input!;
    target.output += addition.output!;
    target.cacheRead += addition.cacheRead!;
    target.cacheWrite += addition.cacheWrite!;
    target.totalTokens += addition.totalTokens!;
  }
  if (reasoningComplete) target.reasoning += addition.reasoning!;
}

function addCostFacts(target: MutableCost, addition: CostTotals, complete: boolean): void {
  if (!complete) return;
  target.input += addition.input!;
  target.output += addition.output!;
  target.cacheRead += addition.cacheRead!;
  target.cacheWrite += addition.cacheWrite!;
  target.total += addition.total!;
}

function tokenFactsPresent(tokens: TokenTotals): boolean {
  return tokens.input !== null && tokens.output !== null && tokens.cacheRead !== null
    && tokens.cacheWrite !== null && tokens.totalTokens !== null;
}

function costFactsPresent(cost: CostTotals): boolean {
  return cost.input !== null && cost.output !== null && cost.cacheRead !== null
    && cost.cacheWrite !== null && cost.total !== null;
}

function modelKey(message: Record<string, unknown>): string {
  const provider = typeof message.provider === "string" ? message.provider : "unknown-provider";
  const model = typeof message.responseModel === "string" && message.responseModel.length > 0
    ? message.responseModel
    : typeof message.model === "string" ? message.model : "unknown-model";
  return `${provider}:${model}`;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
