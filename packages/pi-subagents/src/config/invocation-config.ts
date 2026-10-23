import { minPositive } from "#src/config/resource-limits";
import type { AgentConfig, ThinkingLevel } from "#src/types";

interface AgentInvocationParams {
  model?: string;
  thinking?: string;
  max_turns?: number;
  wrap_up_turns?: number;
  max_duration_seconds?: number;
  run_in_background?: boolean;
  inherit_context?: boolean;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
): {
  modelInput?: string;
  modelFromParams: boolean;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  wrapUpTurns?: number;
  maxDurationSeconds?: number;
  inheritContext: boolean;
  runInBackground: boolean;
} {
  return {
    modelInput: agentConfig?.model ?? params.model,
    modelFromParams: agentConfig?.model == null && params.model != null,
    thinking: (agentConfig?.thinking ?? params.thinking) as ThinkingLevel | undefined,
    // Turn and duration budgets may only tighten: when both the profile and the
    // tool call define one, the smaller value wins rather than the profile value.
    maxTurns: minPositive(agentConfig?.maxTurns, params.max_turns),
    wrapUpTurns: params.wrap_up_turns ?? agentConfig?.wrapUpTurns,
    maxDurationSeconds: minPositive(agentConfig?.maxDurationSeconds, params.max_duration_seconds),
    inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
    runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? false,
  };
}
