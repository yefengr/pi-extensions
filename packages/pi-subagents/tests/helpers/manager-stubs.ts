/**
 * manager-stubs.ts — Shared createSubagentSession factory stubs for lifecycle tests.
 *
 * The factory produces a born-complete SubagentSession (issue #265). These
 * helpers wrap the SubagentSession stub from mock-session into the factory shape
 * SubagentManager injects into each Subagent. Tests with unique turn-loop behavior
 * (event-emitting, gated, error-throwing) configure the returned stub directly.
 *
 * createSessionStub() adapts the raw mock-session stub to the phase/outcome
 * contract: runTurnLoop/resumeTurnLoop resolve classified TurnLoopResults and
 * abort() records the session-level abort the agent forwards on cancellation.
 */
import type { Mock } from "vitest";
import { vi } from "vitest";
import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import type {
  SubagentSession,
  TurnLoopOptions,
  TurnLoopResult,
} from "#src/lifecycle/subagent-session";
import {
  createMockSession,
  createSubagentSessionStub,
  type MockSession,
} from "#test/helpers/mock-session";

// ── createSessionStub ────────────────────────────────────────────────────────

type RawSessionStub = ReturnType<typeof createSubagentSessionStub>;

/**
 * SubagentSession stub carrying the phase/outcome turn-loop contract:
 * `runTurnLoop`/`resumeTurnLoop` resolve classified results and `abort`
 * represents the session-level abort the agent forwards on cancellation.
 */
export type SessionStub = Omit<RawSessionStub, "runTurnLoop" | "resumeTurnLoop"> & {
  runTurnLoop: Mock<(prompt: string, opts: TurnLoopOptions) => Promise<TurnLoopResult>>;
  resumeTurnLoop: Mock<(prompt: string, opts: TurnLoopOptions) => Promise<TurnLoopResult>>;
  abort: Mock<() => Promise<void>>;
};

/**
 * Build a SubagentSession stub whose turn loops resolve the new TurnLoopResult
 * shape (`{responseText, outcome, wrappedUp}`) and which exposes the `abort`
 * method the agent calls when an invocation is cancelled.
 */
export function createSessionStub(
  session: MockSession = createMockSession(),
  outputFile?: string,
  sessionId?: string,
): SessionStub {
  const stub = createSubagentSessionStub(session, outputFile, sessionId) as unknown as SessionStub;
  stub.runTurnLoop = vi.fn(async () => ({ responseText: "done", outcome: "completed", wrappedUp: false }));
  stub.resumeTurnLoop = vi.fn(async () => ({ responseText: "resumed", outcome: "completed", wrappedUp: false }));
  stub.abort = vi.fn(async (): Promise<void> => undefined);
  return stub;
}

/** Cast an adapted stub to SubagentSession for assignment to a Subagent record. */
export function asSubagentSession(stub: SessionStub): SubagentSession {
  return stub as unknown as SubagentSession;
}

// ── createBlockingFactory ────────────────────────────────────────────────────

/**
 * A factory whose creation never resolves.
 *
 * Use when a test needs an agent to stay "running" with no session yet created
 * (e.g., to inspect queued records or test abort behavior).
 */
export function createBlockingFactory() {
  return vi.fn((_params: CreateSubagentSessionParams) => new Promise<SubagentSession>(() => {}));
}

// ── createSessionFactory ─────────────────────────────────────────────────────

/**
 * A factory returning an adapted SubagentSession stub wrapping the given (or a
 * fresh) session. Returns the factory plus the stub and session so tests can
 * configure `runTurnLoop`/`resumeTurnLoop` and emit session events.
 */
export function createSessionFactory(session: MockSession = createMockSession(), outputFile?: string) {
  const stub = createSessionStub(session, outputFile);
  const factory = vi.fn(async (_params: CreateSubagentSessionParams) => asSubagentSession(stub));
  return { factory, stub, session };
}
