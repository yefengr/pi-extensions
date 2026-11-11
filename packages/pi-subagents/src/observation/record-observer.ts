/**
 * record-observer.ts — Subscribes to session events and accumulates SubagentState stats.
 *
 * Replaces the scattered callback-wrapping logic in SubagentManager's startAgent()
 * and resume() with a single direct subscription. The observer targets the
 * SubagentState value object directly, so it carries no dependency on Subagent;
 * the caller forwards itself to its own lifecycle observer via onCompact.
 */

import type { SubagentState } from "#src/lifecycle/subagent-state";
import type { CompactionInfo, SubscribableSession } from "#src/types";

export interface SubagentObserverOptions {
  onCompact?: (info: CompactionInfo) => void;
}

/**
 * Subscribe to session events and accumulate stats on the subagent state.
 *
 * Handles:
 * - `tool_execution_start` → `state.addActiveTool(name)`
 * - `tool_execution_end` → `state.removeActiveTool(name)`, `state.incrementToolUses()`
 * - `message_start` → `state.resetResponseText()`
 * - `message_update` (text_delta) → `state.appendResponseText(delta)`
 * - `message_end` (assistant, with usage) → `state.addUsage(…)`
 * - `turn_end` → `state.incrementTurnCount()`
 * - `compaction_end` (not aborted) → `state.incrementCompactions()`, call `onCompact`
 *
 * @returns An unsubscribe function.
 */
export function subscribeSubagentObserver(
  session: SubscribableSession,
  state: SubagentState,
  options?: SubagentObserverOptions,
): () => void {
  return session.subscribe((event) => {
    if (event.type === "turn_start") state.noteProgress("model");
    if (event.type === "compaction_start" || event.type === "compaction_end") {
      state.noteProgress(event.type === "compaction_start" ? "compacting" : "model");
    }
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      state.noteProgress("tool");
    }
    if (event.type === "message_start" && event.message?.role === "assistant") state.noteProgress("response");
    if (event.type === "message_update") {
      const type = event.assistantMessageEvent.type;
      if (type === "text_start" || type === "text_delta" || type === "text_end" || type === "done") state.noteProgress("response");
      else if (type === "thinking_start" || type === "thinking_delta" || type === "thinking_end") state.noteProgress("model");
    }
    if (event.type === "message_end" && event.message.role === "assistant") state.noteProgress("response");

    if (event.type === "tool_execution_start") {
      state.addActiveTool(event.toolName);
    }

    if (event.type === "tool_execution_end") {
      state.removeActiveTool(event.toolName);
      state.incrementToolUses();
    }

    if (event.type === "message_start") {
      state.resetResponseText();
    }

    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      state.appendResponseText(event.assistantMessageEvent.delta);
    }

    if (event.type === "turn_end") {
      state.incrementTurnCount();
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      const u = event.message.usage;
      state.addUsage({
        input: u.input,
        output: u.output,
        cacheWrite: u.cacheWrite,
      });
    }

    if (event.type === "compaction_end" && !event.aborted && event.result) {
      state.incrementCompactions();
      options?.onCompact?.({
        reason: event.reason,
        tokensBefore: event.result.tokensBefore,
      });
    }
  });
}
