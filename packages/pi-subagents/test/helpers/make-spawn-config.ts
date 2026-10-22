import type { ResolvedSpawnConfig } from "#src/tools/spawn-config";

/** Flat options for {@link createResolvedSpawnConfig}; only the scalars tests vary. */
export interface ResolvedSpawnConfigOptions {
  subagentType?: string;
  rawType?: string;
  fellBack?: boolean;
  displayName?: string;
  prompt?: string;
  description?: string;
  model?: string;
  runInBackground?: boolean;
  /** Effective hard turn budget; defaults to the global settings default. */
  effectiveMaxTurns?: number;
  /** Effective wrap-up window; defaults to the global settings default. */
  effectiveWrapUpTurns?: number;
  /** Effective run-duration budget in seconds; defaults to the global settings default. */
  effectiveMaxDurationSeconds?: number;
}

/**
 * Build a `ResolvedSpawnConfig` for tool tests from flat options.
 *
 * Derives the mirrored regions the hand-built fixtures duplicate:
 * `execution.runInBackground` → `execution.agentInvocation.runInBackground`, and
 * `displayName`/`description`/`subagentType`/`model` → `presentation.detailBase`.
 * Flat options sidestep the `Partial<ResolvedSpawnConfig>` deep-merge trap.
 *
 * The effective budgets default to the global settings defaults (30/2/1800),
 * mirroring what `resolveSpawnConfig` produces with no profile or tool-call caps.
 */
export function createResolvedSpawnConfig(
  options: ResolvedSpawnConfigOptions = {},
): ResolvedSpawnConfig {
  const subagentType = options.subagentType ?? "general-purpose";
  const displayName = options.displayName ?? "Agent";
  const description = options.description ?? "task";
  const runInBackground = options.runInBackground ?? false;
  const modelName = options.model;

  return {
    identity: {
      subagentType,
      rawType: options.rawType ?? subagentType,
      fellBack: options.fellBack ?? false,
      displayName,
    },
    execution: {
      prompt: options.prompt ?? "do the task",
      description,
      model: undefined,
      effectiveMaxTurns: options.effectiveMaxTurns ?? 30,
      effectiveWrapUpTurns: options.effectiveWrapUpTurns ?? 2,
      effectiveMaxDurationSeconds: options.effectiveMaxDurationSeconds ?? 1800,
      thinking: undefined,
      inheritContext: false,
      runInBackground,
      agentInvocation: {
        modelName,
        thinking: undefined,
        maxTurns: undefined,
        wrapUpTurns: undefined,
        maxDurationSeconds: undefined,
        inheritContext: false,
        runInBackground,
      },
    },
    presentation: {
      modelName,
      agentTags: [],
      detailBase: { displayName, description, subagentType, modelName, tags: undefined },
    },
  };
}
