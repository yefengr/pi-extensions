/**
 * spawn-config.ts — Pure config resolution for the Agent tool.
 *
 * Extracts all config resolution logic from execute: type resolution,
 * invocation config merge, model resolution, runtime budget merging,
 * tag building, and detail-base construction.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { AgentTypeRegistry } from "#src/config/agent-types";
import { resolveAgentInvocationConfig } from "#src/config/invocation-config";
import { clampWrapUpTurns, minPositive } from "#src/config/resource-limits";
import type { ModelRegistry } from "#src/session/model-resolver";
import { resolveInvocationModel } from "#src/session/model-resolver";
import type { AgentInvocation, SubagentType, ThinkingLevel } from "#src/types";
import {
  type AgentDetails,
  buildInvocationTags,
  getDisplayName,
  getPromptModeLabel,
} from "#src/ui/display";

/** Model info extracted from the parent session context. */
export interface ModelInfo {
  parentModel: Model<any> | undefined;
  modelRegistry: ModelRegistry | undefined;
}

/** Identity: who is being spawned. */
export interface SpawnIdentity {
  subagentType: string;
  rawType: SubagentType;
  fellBack: boolean;
  displayName: string;
}

/** Execution: how the agent will run. */
export interface SpawnExecution {
  prompt: string;
  description: string;
  model: Model<any> | undefined;
  /** Effective hard turn budget: minimum over global, profile, and tool call. */
  effectiveMaxTurns: number;
  /** Effective wrap-up window in turns, below effectiveMaxTurns. */
  effectiveWrapUpTurns: number;
  /** Effective run-duration budget in seconds: minimum over global, profile, and tool call. */
  effectiveMaxDurationSeconds: number;
  thinking: ThinkingLevel | undefined;
  inheritContext: boolean;
  runInBackground: boolean;
  agentInvocation: AgentInvocation;
}

/** Presentation: display/UI values derived from identity and execution. */
export interface SpawnPresentation {
  modelName: string | undefined;
  agentTags: string[];
  detailBase: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">;
}

/** Fully resolved config for spawning an agent — composed of domain-aligned sub-interfaces. */
export interface ResolvedSpawnConfig {
  identity: SpawnIdentity;
  execution: SpawnExecution;
  presentation: SpawnPresentation;
}

/** Error result when model resolution fails. */
export interface SpawnConfigError {
  error: string;
}

/** Runtime budgets read from the global settings layer. */
export interface SpawnSettings {
  readonly maxTurns: number;
  readonly wrapUpTurns: number;
  readonly maxDurationSeconds: number;
}

/**
 * Resolve all config for an Agent tool invocation.
 *
 * Pure function — no SDK types, no side effects.
 * Returns either a fully resolved config or an error.
 */
export function resolveSpawnConfig(
  params: Record<string, unknown>,
  registry: AgentTypeRegistry,
  modelInfo: ModelInfo,
  settings: SpawnSettings,
): ResolvedSpawnConfig | SpawnConfigError {
  const rawType = params.subagent_type as SubagentType;
  const resolved = registry.resolveType(rawType);

  let subagentType: string;
  try {
    subagentType = registry.resolveSpawnType(rawType);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const fellBack = resolved === undefined;

  const displayName = getDisplayName(subagentType, registry);

  // Merge agent config defaults with tool-call params
  const customConfig = registry.resolveAgentConfig(subagentType);
  const resolvedConfig = resolveAgentInvocationConfig(customConfig, params);

  // Resolve model
  const resolution = resolveInvocationModel(
    modelInfo.parentModel,
    resolvedConfig.modelInput,
    resolvedConfig.modelFromParams,
    modelInfo.modelRegistry,
  );
  if (resolution.error) return { error: resolution.error };
  const model = resolution.model;

  const thinking = resolvedConfig.thinking;
  const inheritContext = resolvedConfig.inheritContext;
  const runInBackground = resolvedConfig.runInBackground;

  // Compute display model name (only shown when different from parent)
  const parentModelId = modelInfo.parentModel?.id;
  const effectiveModelId = model?.id;
  const modelName =
    effectiveModelId && effectiveModelId !== parentModelId
      ? model.name.replace(/^Claude\s+/i, "").toLowerCase()
      : undefined;

  // Budgets: global values always exist; profile and tool-call values may only
  // tighten them, so the effective value is the minimum of every defined layer.
  const effectiveMaxTurns = minPositive(settings.maxTurns, resolvedConfig.maxTurns) ?? settings.maxTurns;
  const effectiveMaxDurationSeconds =
    minPositive(settings.maxDurationSeconds, resolvedConfig.maxDurationSeconds) ??
    settings.maxDurationSeconds;
  // Wrap-up precedence is invocation > profile > global, then clamped below the
  // effective hard stop so the soft limit always fires before the hard stop.
  const effectiveWrapUpTurns = clampWrapUpTurns(
    resolvedConfig.wrapUpTurns ?? settings.wrapUpTurns,
    effectiveMaxTurns,
  );

  const agentInvocation: AgentInvocation = {
    modelName,
    thinking,
    maxTurns: resolvedConfig.maxTurns,
    wrapUpTurns: resolvedConfig.wrapUpTurns,
    maxDurationSeconds: resolvedConfig.maxDurationSeconds,
    inheritContext,
    runInBackground,
  };

  const modeLabel = getPromptModeLabel(subagentType, registry);
  const { tags: invocationTags } = buildInvocationTags(agentInvocation);
  const agentTags = modeLabel ? [modeLabel, ...invocationTags] : invocationTags;

  const detailBase = {
    displayName,
    description: params.description as string,
    subagentType,
    modelName,
    tags: agentTags.length > 0 ? agentTags : undefined,
  };

  return {
    identity: { subagentType, rawType, fellBack, displayName },
    execution: {
      prompt: params.prompt as string,
      description: params.description as string,
      model,
      effectiveMaxTurns,
      effectiveWrapUpTurns,
      effectiveMaxDurationSeconds,
      thinking,
      inheritContext,
      runInBackground,
      agentInvocation,
    },
    presentation: { modelName, agentTags, detailBase },
  };
}
