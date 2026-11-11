import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { debugLog } from "#src/debug";
import { getSubagentProgress } from "#src/lifecycle/progress";
import { formatLifetimeTokens } from "#src/tools/helpers";
import type { ResolvedSpawnConfig } from "#src/tools/spawn-config";
import type { Subagent } from "#src/types";
import type { AgentDetails } from "#src/ui/display";
import { SPINNER } from "#src/ui/glyphs";

/** Share the existing foreground spinner across fresh and resumed invocations. */
export async function withForegroundProgress<T>(
  config: ResolvedSpawnConfig,
  getRecord: () => Subagent | undefined,
  onUpdate: ((update: AgentToolResult<AgentDetails>) => void) | undefined,
  run: () => Promise<T>,
): Promise<T> {
  let frame = 0;
  const startedAt = Date.now();
  let updatesEnabled = true;
  const update = () => {
    if (!updatesEnabled) return;
    const record = getRecord();
    const toolUses = record?.invocationToolUses ?? 0;
    const progress = getSubagentProgress(record ?? {
      phase: "running", invocationTurnCount: 0, maxTurns: config.execution.effectiveMaxTurns,
      activeTools: new Map(), responseText: "",
    });
    try { onUpdate?.({
      content: [{ type: "text", text: `${toolUses} tool uses...` }],
      details: {
        ...config.presentation.detailBase,
        ...progress,
        toolUses,
        tokens: record ? formatLifetimeTokens({ lifetimeUsage: record.invocationUsage }) : "",
        lifetimeTurnCount: record?.lifetimeTurnCount ?? 0,
        durationMs: Date.now() - startedAt,
        phase: "running",
        spinnerFrame: frame % SPINNER.length,
      },
    }); } catch (error) {
      updatesEnabled = false;
      clearInterval(timer);
      debugLog("foreground progress callback", error);
    }
  };
  const timer = onUpdate ? setInterval(() => { frame++; update(); }, 80) : undefined;
  try {
    // Admission/reset happens before the first update, so resume never displays
    // the previous invocation's response or counters.
    const result = run();
    update();
    return await result;
  } finally {
    clearInterval(timer);
  }
}
