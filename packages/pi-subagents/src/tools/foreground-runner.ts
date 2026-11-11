import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import type { AgentSpawnConfig } from "#src/lifecycle/subagent-manager";
import { withForegroundProgress } from "#src/tools/foreground-progress";
import {
  buildDetails,
  formatLifetimeTokens,
  getOutcomeNote,
  textResult,
} from "#src/tools/helpers";
import type { ResolvedSpawnConfig } from "#src/tools/spawn-config";
import type { ParentSessionInfo, Subagent } from "#src/types";
import { type AgentDetails, formatMs } from "#src/ui/display";

/** Narrow manager interface for the foreground runner. */
export interface ForegroundManagerDeps {
  spawnAndWait(
    snapshot: ParentSnapshot,
    type: string,
    prompt: string,
    opts: Omit<AgentSpawnConfig, "isBackground">,
  ): Promise<Subagent>;
}

/** All values the foreground runner needs beyond the resolved config. */
export interface ForegroundParams {
  config: ResolvedSpawnConfig;
  snapshot: ParentSnapshot;
  parentSession: ParentSessionInfo;
}

/**
 * Run an agent synchronously in the foreground, streaming spinner updates.
 * Owns: spinner interval, streaming onUpdate callbacks, cleanup, and result formatting.
 */
export async function runForeground(
  manager: ForegroundManagerDeps,
  params: ForegroundParams,
  signal: AbortSignal | undefined,
  onUpdate: ((update: AgentToolResult<AgentDetails>) => void) | undefined,
) {
  const { identity, execution, presentation } = params.config;
  let recordRef: Subagent | undefined;

  let record: Subagent;
  try {
    record = await withForegroundProgress(params.config, () => recordRef, onUpdate, () => manager.spawnAndWait(
      params.snapshot,
      identity.subagentType,
      execution.prompt,
      {
        description: execution.description,
        model: execution.model,
        maxTurns: execution.effectiveMaxTurns,
        wrapUpTurns: execution.effectiveWrapUpTurns,
        maxDurationSeconds: execution.effectiveMaxDurationSeconds,
        inheritContext: execution.inheritContext,
        thinkingLevel: execution.thinking,
        invocation: execution.agentInvocation,
        signal,
        parentSession: params.parentSession,
        observer: {
          onSessionCreated: (agent) => {
            recordRef = agent;
          },
        },
      },
    ));
  } catch (err) {
    return textResult(err instanceof Error ? err.message : String(err));
  }

  // Foreground-return delivery edge: the result is handed back in this tool
  // result, so the outcome is collected. Mark it consumed.
  record.markConsumed();

  const tokenText = formatLifetimeTokens(record);
  const details = buildDetails(presentation.detailBase, record, { tokens: tokenText });

  const fallbackNote = identity.fellBack
    ? `Note: Unknown agent type "${identity.rawType}" — using general-purpose.\n\n`
    : "";
  const agentIdentity = `Agent ID: ${record.id}\n`;

  if (record.outcome === "error") {
    return textResult(`${fallbackNote}${agentIdentity}Agent failed: ${record.error}`, details);
  }

  const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
  const statsParts = [`${record.toolUses} tool uses`];
  if (tokenText) statsParts.push(tokenText);
  return textResult(
    `${fallbackNote}${agentIdentity}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getOutcomeNote(record.outcome, record.stoppedWhileQueued)}.\n\n` +
      (record.result?.trim() ?? "No output."),
    details,
  );
}
