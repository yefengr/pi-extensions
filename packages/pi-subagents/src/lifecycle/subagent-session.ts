/**
 * subagent-session.ts — The born-complete child-session value object (issue #265).
 *
 * A SubagentSession wraps one SDK AgentSession plus its turn-driving and teardown.
 * It is born complete: `createSubagentSession()` returns a fully usable instance
 * (session created, extensions bound, recursion guard applied), so the only thing
 * left for `Subagent` to do is coordinate — drive the turn loop, steer, dispose.
 *
 * Turn driving lives here, on the object that owns the AgentSession, rather than
 * reaching through `subagentSession.session` from `Subagent` (Law of Demeter).
 */

import {
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ChildLifecyclePublisher } from "#src/lifecycle/child-lifecycle";
import { emitChildSessionShutdown } from "#src/lifecycle/child-shutdown";
import { isInvocationTimeout } from "#src/lifecycle/invocation-control";
import { getSessionContextPercent, type SessionStatsLike } from "#src/lifecycle/usage";
import { extractText } from "#src/session/context";
import { getAgentConversation } from "#src/session/conversation";
import type { SessionMessage } from "#src/types";

export type TurnLoopOutcome = "completed" | "turn_limit" | "timeout" | "cancelled";

/** Outcome of one invocation's model turn loop. */
export interface TurnLoopResult {
  responseText: string;
  outcome: TurnLoopOutcome;
  /** Whether the agent received the configured wrap-up instruction. */
  wrappedUp: boolean;
}

/** Strict limits for one fresh or resumed invocation. */
export interface TurnLoopOptions {
  maxTurns: number;
  wrapUpTurns: number;
  signal?: AbortSignal;
}

/** Session-level facts known at creation, supplied by the factory. */
export interface SubagentSessionMeta {
  /** Path to the persisted session JSONL file, if the session was persisted. */
  outputFile: string | undefined;
  /** Child session id — the registry key carried on session-created/disposed events. */
  sessionId: string;
  /** Child session directory — carried on the completed event as transcript location. */
  sessionDir: string;
  agentName: string;
  /** Parent context prepended to the run prompt, captured at spawn time. */
  parentContext: string | undefined;
  lifecycle: ChildLifecyclePublisher;
}

/**
 * One child AgentSession plus its turn-driving and teardown — born complete.
 */
export class SubagentSession {
  private disposed = false;

  constructor(
    private readonly _session: AgentSession,
    private readonly meta: SubagentSessionMeta,
  ) {}

  /**
   * Wrapped session — for lifecycle-internal use only.
   * @internal consumers outside lifecycle/ use the delegate methods below.
   */
  get session(): AgentSession {
    return this._session;
  }

  /** Stable Pi session identifier for transcript attribution. */
  get sessionId(): string {
    return this.meta.sessionId;
  }

  get outputFile(): string | undefined {
    return this.meta.outputFile;
  }

  /** Drive the initial invocation and publish its child-session outcome. */
  async runTurnLoop(prompt: string, opts: TurnLoopOptions): Promise<TurnLoopResult> {
    const effectivePrompt = this.meta.parentContext
      ? this.meta.parentContext + prompt
      : prompt;
    const result = await this.executePrompt(effectivePrompt, opts);
    this.meta.lifecycle.completed({
      sessionDir: this.meta.sessionDir,
      agentName: this.meta.agentName,
      outcome: result.outcome,
      wrappedUp: result.wrappedUp,
    });
    return result;
  }

  /** Re-prompt the same session with a fresh invocation budget. */
  async resumeTurnLoop(prompt: string, opts: TurnLoopOptions): Promise<TurnLoopResult> {
    return this.executePrompt(prompt, opts);
  }

  private async executePrompt(prompt: string, opts: TurnLoopOptions): Promise<TurnLoopResult> {
    const session = this._session;
    let turnCount = 0;
    let wrappedUp = false;
    let hardLimitRequiredAbort = false;
    const wrapUpAt = opts.maxTurns - Math.min(opts.wrapUpTurns, opts.maxTurns - 1);

    const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
      if (event.type !== "turn_end") return;

      turnCount++;
      const assistantContinues = turnNeedsContinuation(event);
      if (
        !wrappedUp &&
        opts.wrapUpTurns > 0 &&
        turnCount >= wrapUpAt &&
        turnCount < opts.maxTurns &&
        assistantContinues
      ) {
        wrappedUp = true;
        void session.steer(
          "You are approaching your hard turn limit. Stop exploring and provide your final answer now.",
        );
      }

      if (turnCount >= opts.maxTurns && assistantContinues) {
        hardLimitRequiredAbort = true;
        void session.abort();
      }
    });

    const collector = collectResponseText(session);
    const cleanupAbort = forwardAbortSignal(session, opts.signal);

    try {
      await session.prompt(prompt);
    } finally {
      unsubTurns();
      collector.unsubscribe();
      cleanupAbort();
    }

    const responseText = collector.getText().trim() || getLastAssistantText(session);
    const outcome = resolveTurnLoopOutcome(opts.signal, hardLimitRequiredAbort);
    return { responseText, outcome, wrappedUp };
  }

  /** Deliver a steer to the live session. */
  async steer(message: string): Promise<void> {
    await this._session.steer(message);
  }

  /** Abort the current SDK operation. */
  async abort(): Promise<void> {
    await this._session.abort();
  }

  /** Return the session's conversation as formatted text. */
  getConversation(): string {
    return getAgentConversation(this._session);
  }

  /** Return the session context window utilization (0-100), or null when unavailable. */
  getContextPercent(): number | null {
    return getSessionContextPercent(this._session);
  }

  /** Subscribe to session events. Satisfies `SubscribableSession`. */
  subscribe(fn: (event: AgentSessionEvent) => void): () => void {
    return this._session.subscribe(fn);
  }

  /** Return session token statistics. Satisfies `SessionLike`. */
  getSessionStats(): SessionStatsLike {
    return this._session.getSessionStats();
  }

  /** The session's message history. */
  get messages(): readonly unknown[] {
    return this._session.messages as readonly unknown[];
  }

  /** The session's message history, typed for Pi's session-rendering machinery. */
  get agentMessages(): readonly SessionMessage[] {
    return this._session.messages;
  }

  /** Resolve a registered tool definition by name, for Pi's tool-execution components. */
  getToolDefinition(name: string): ToolDefinition | undefined {
    return this._session.getToolDefinition(name);
  }

  /**
   * Tear down: child `session_shutdown` + session.dispose() + emit `disposed`
   * (registry unregister).
   *
   * The order is load-bearing. The shutdown emit runs first because
   * `AgentSession.dispose()` invalidates the extension runner, after which every
   * handler's context throws (#709). The `disposed` event runs last because it
   * unregisters the child from the permission system, so a shutdown handler
   * still resolves against a live registration.
   *
   * Idempotent: the guard is set before the first await, so concurrent callers
   * (a retention sweep racing a manager teardown) emit and dispose exactly once.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await emitChildSessionShutdown(this._session);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- dispose may not exist on all session implementations
    this._session.dispose?.();
    this.meta.lifecycle.disposed({ sessionId: this.meta.sessionId });
  }
}

// ── Private turn-loop helpers ───────────────────────────────────────────────────

/**
 * Subscribe to a session and collect the last assistant message text.
 * Returns an object with a `getText()` getter and an `unsubscribe` function.
 */
function collectResponseText(session: AgentSession) {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") {
      text = "";
    }
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      text += event.assistantMessageEvent.delta;
    }
  });
  return { getText: () => text, unsubscribe };
}

/** Get the last assistant text from the completed session history. */
function getLastAssistantText(session: AgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
function forwardAbortSignal(
  session: AgentSession,
  signal?: AbortSignal,
): () => void {
  if (!signal) return () => {};
  const onAbort = (): void => {
    void session.abort();
  };
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function turnNeedsContinuation(event: Extract<AgentSessionEvent, { type: "turn_end" }>): boolean {
  if (event.message.role !== "assistant") return false;
  if (event.message.stopReason === "length") return true;
  return event.message.content.some((content) => content.type === "toolCall");
}

function resolveTurnLoopOutcome(
  signal: AbortSignal | undefined,
  hardLimitRequiredAbort: boolean,
): TurnLoopOutcome {
  if (signal?.aborted) {
    return isInvocationTimeout(signal.reason) ? "timeout" : "cancelled";
  }
  return hardLimitRequiredAbort ? "turn_limit" : "completed";
}
