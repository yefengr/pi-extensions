import type { AgentConfigLookup } from "#src/config/agent-types";
import type { SubagentOutcome, SubagentPhase } from "#src/lifecycle/subagent-state";
import { getLifetimeTotal, type LifetimeUsage } from "#src/lifecycle/usage";
import { type AgentDetails, formatTokens } from "#src/ui/display";

/** Parenthetical outcome note for completed agent result text. */
export function getOutcomeNote(
  outcome: SubagentOutcome | undefined,
  stoppedWhileQueued = false,
): string {
  if (stoppedWhileQueued && (outcome === "cancelled" || outcome === "queue_timeout")) {
    return " (stopped before starting)";
  }
  switch (outcome) {
    case "turn_limit":
      return " (Turn limit reached)";
    case "timeout":
      return " (Timed out)";
    case "queue_timeout":
      return " (Queue timed out)";
    case "cancelled":
      return " (Cancelled)";
    default:
      return "";
  }
}

/** Build AgentDetails from a base + record-specific fields. */
export function buildDetails(
  base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">,
  record: {
    toolUses: number;
    startedAt: number;
    completedAt?: number;
    phase: SubagentPhase;
    outcome?: SubagentOutcome;
    error?: string;
    id?: string;
    lifetimeUsage: LifetimeUsage;
    /** Live-activity counters — exposed as getters on Subagent (Phase 18 Step 2). */
    invocationTurnCount?: number;
    lifetimeTurnCount?: number;
    maxTurns?: number;
  },
  overrides?: Partial<AgentDetails>,
): AgentDetails {
  return {
    ...base,
    toolUses: record.toolUses,
    tokens: formatLifetimeTokens(record),
    invocationTurnCount: record.invocationTurnCount,
    lifetimeTurnCount: record.lifetimeTurnCount,
    maxTurns: record.maxTurns,
    durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
    phase: record.phase,
    ...(record.outcome ? { outcome: record.outcome } : {}),
    agentId: record.id,
    error: record.error,
    ...overrides,
  };
}

/** Tool execute return value for a text response. */
export function textResult(msg: string, details?: AgentDetails) {
  return { content: [{ type: "text" as const, text: msg }], details };
}

/** Format an agent's lifetime token total, or "" when zero. */
export function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
  const t = getLifetimeTotal(o.lifetimeUsage);
  return t > 0 ? formatTokens(t) : "";
}

/**
 * Narrow registry interface needed by buildTypeListText.
 * Extends AgentConfigLookup with the two name-listing methods.
 */
export interface TypeListRegistry extends AgentConfigLookup {
  getDefaultAgentNames(): string[];
  getUserAgentNames(): string[];
}

/**
 * Build the full agent-type list text for the Agent tool description.
 * Extracted from index.ts so it can be called inside createAgentTool.
 */
export function buildTypeListText(registry: TypeListRegistry, agentDir: string): string {
  const defaultNames = registry.getDefaultAgentNames().filter((name) => isEnabledAgent(registry, name));
  const userNames = registry.getUserAgentNames().filter((name) => isEnabledAgent(registry, name));

  const defaultDescs = defaultNames.map((name) => {
    const cfg = registry.resolveAgentConfig(name);
    const modelSuffix = cfg.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
    return `- ${name}: ${cfg.description}${modelSuffix}`;
  });

  const customDescs = userNames.map((name) => {
    const cfg = registry.resolveAgentConfig(name);
    return `- ${name}: ${cfg.description}`;
  });

  return [
    ...(defaultDescs.length > 0 ? ["Default agents:", ...defaultDescs] : []),
    ...(customDescs.length > 0 ? ["", "Custom agents:", ...customDescs] : []),
    "",
    `Custom agents can be defined in .pi/agents/<name>.md (project) or ${agentDir}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.`,
  ].join("\n");
}

/** True when an agent config is present and not explicitly disabled. */
function isEnabledAgent(registry: AgentConfigLookup, name: string): boolean {
  return registry.resolveAgentConfig(name).enabled !== false;
}

/**
 * Collect the per-agent usage guidelines for the subagent tool's Guidelines: block.
 * Sourced from each enabled default agent's `toolGuideline`, in registry order,
 * so a disabled built-in drops its guideline automatically.
 */
export function buildAgentGuidelines(registry: TypeListRegistry): string[] {
  return registry
    .getDefaultAgentNames()
    .filter((name) => isEnabledAgent(registry, name))
    .map((name) => registry.resolveAgentConfig(name).toolGuideline)
    .filter((line): line is string => line !== undefined);
}

/** Derive a short model label from a model string. */
export function getModelLabelFromConfig(model: string): string {
  // Strip provider prefix (e.g. "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6")
  const name = model.includes("/") ? model.split("/").pop()! : model;
  // Strip trailing date suffix (e.g. "claude-haiku-4-5-20251001" → "claude-haiku-4-5")
  return name.replace(/-\d{8}$/, "");
}
