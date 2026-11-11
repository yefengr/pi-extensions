/**
 * runtime.ts — SubagentRuntime: composition root for all mutable extension state.
 *
 * Eliminates module-scope state in agent-runner.ts and closure-scoped state
 * in index.ts by consolidating them into a single, testable object.
 * Follows the same pattern as pi-permission-system's ExtensionRuntime.
 */

import type { BeforeAgentStartEvent, BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { buildParentSnapshot, type ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import type { ModelInfo } from "#src/tools/spawn-config";
import type { SessionContext } from "#src/types";

/** Runtime safety ceilings shared by tool and service-driven invocations. */
export interface RunConfig {
  readonly maxTurns: number;
  readonly wrapUpTurns: number;
  readonly maxDurationSeconds: number;
  readonly maxQueueWaitSeconds: number;
  readonly abortGraceSeconds: number;
}

/**
 * All mutable state owned by the pi-subagents extension.
 *
 * Created once inside `piSubagentsExtension()` via `createSubagentRuntime()`.
 * Tests construct a fresh runtime per test for full isolation.
 */
export class SubagentRuntime {
  constructor(private readonly readAvailableTools?: () => string[]) {}
  // ── Session state (was closure-scoped in index.ts) ───────────────────────
  /** Active Pi session context — set on session_start, cleared on session_shutdown. */
  currentCtx: SessionContext | undefined = undefined;
  private pendingPrompt?: BeforeAgentStartEvent;
  private effectivePrompt?: { text: string; options: BuildSystemPromptOptions };

  capturePrompt(event: BeforeAgentStartEvent): void {
    // Keep the event reference: later handlers mutate the same SDK options.
    this.pendingPrompt = event;
    this.effectivePrompt = undefined;
  }

  confirmPrompt(ctx: SessionContext): void {
    this.effectivePrompt = undefined;
    const event = this.pendingPrompt;
    if (!event || event.systemPrompt !== ctx.getSystemPrompt()) return;
    this.effectivePrompt = {
      text: event.systemPrompt,
      options: structuredClone(event.systemPromptOptions),
    };
  }

  // ── Session-context methods ──────────────────────────────────────────────

  /** Store the active Pi session context (called from session_start). */
  setSessionContext(ctx: SessionContext): void {
    this.currentCtx = ctx;
  }

  /** Clear the session context (called from session_shutdown). */
  clearSessionContext(): void {
    this.currentCtx = undefined;
    this.pendingPrompt = undefined;
    this.effectivePrompt = undefined;
  }

  /**
   * Build a parent snapshot from the current session context.
   * Only valid during an active session (currentCtx is defined).
   */
  buildSnapshot(inheritContext: boolean): ParentSnapshot {
    const ctx = this.currentCtx;
    if (!ctx) throw new Error("No active parent session");
    if (this.pendingPrompt?.systemPromptOptions.forceSystemPrompt !== undefined) {
      throw new Error("Cannot inherit an opaque forceSystemPrompt; use structured systemPromptOptions");
    }
    if (this.pendingPrompt && this.pendingPrompt.systemPrompt !== ctx.getSystemPrompt()) {
      throw new Error("Parent structured system prompt no longer matches the effective prompt");
    }
    const captured = this.effectivePrompt;
    // Real SDK contexts must never fall back to the parent's opaque rendered text.
    if (ctx.isProjectTrusted && (!captured || captured.text !== ctx.getSystemPrompt())) {
      throw new Error("Parent structured system prompt is missing or no longer matches the effective prompt");
    }
    if (captured?.options.forceSystemPrompt !== undefined) {
      throw new Error("Cannot inherit an opaque forceSystemPrompt; use structured systemPromptOptions");
    }
    const snapshot = captured
      ? buildParentSnapshot(ctx, inheritContext, captured.options)
      : buildParentSnapshot(ctx, inheritContext);
    if (this.readAvailableTools) snapshot.availableTools = this.readAvailableTools();
    return snapshot;
  }

  /** Extract model info from the current session context. */
  getModelInfo(): ModelInfo {
    return {
      parentModel: this.currentCtx?.model,
      modelRegistry: this.currentCtx?.modelRegistry,
    };
  }

  /** Extract session identity from the current session context. */
  getSessionInfo(): { parentSessionFile: string; parentSessionId: string } {
    return {
      parentSessionFile: this.currentCtx?.sessionManager.getSessionFile() ?? "",
      parentSessionId: this.currentCtx?.sessionManager.getSessionId() ?? "",
    };
  }
}

/**
 * Create a fully-initialized SubagentRuntime with default values.
 *
 * Call once at extension startup; pass the result to factories and handlers.
 */
export function createSubagentRuntime(readAvailableTools?: () => string[]): SubagentRuntime {
  return new SubagentRuntime(readAvailableTools);
}
