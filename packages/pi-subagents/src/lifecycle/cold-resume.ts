import { statSync } from "node:fs";
import type { CreateSubagentSessionParams, SessionManagerLike } from "#src/lifecycle/create-subagent-session";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { Subagent, type SubagentExecution, type SubagentLifecycleObserver } from "#src/lifecycle/subagent";
import type { AgentSpawnConfig } from "#src/lifecycle/subagent-manager";
import type { SubagentSession } from "#src/lifecycle/subagent-session";
import { SubagentState } from "#src/lifecycle/subagent-state";
import type { RunConfig } from "#src/runtime";
import type { PersistedSubagentStore, SavedAgentHistory } from "#src/session/persisted-records";
import { validateRecoveryTranscript } from "#src/session/recovery-checkpoint";
import type { SessionLease } from "#src/session/session-lease";

export interface ColdResumeIO {
  store: PersistedSubagentStore;
  isEnabled(type: string): boolean;
  acquireLease(file: string, sessionId: string): SessionLease;
  open(file: string): SessionManagerLike & { getCwd(): string };
}
export interface ColdResumeOptions {
  io: ColdResumeIO;
  createSession(params: CreateSubagentSessionParams): Promise<SubagentSession>;
  observer: SubagentLifecycleObserver;
  getRunConfig?: () => RunConfig;
}

/** All refusal checks precede registration or invocation-index mutation. */
export async function recoverSubagent(
  id: string,
  snapshot: ParentSnapshot,
  config: AgentSpawnConfig,
  options: ColdResumeOptions,
): Promise<Subagent> {
  config.signal?.throwIfAborted();
  let history = requireHistory(id, config, options.io);
  const initial = validateRecoveryTranscript(options.io.store.readTranscript(history), history);
  if (!statSync(initial.cwd).isDirectory()) throw new Error("Original child cwd is not a directory");
  const lease = options.io.acquireLease(history.outputFile!, history.latest.sessionId!);
  let initialized = false;
  try {
    const original = history;
    history = requireHistory(id, config, options.io);
    if (history.outputFile !== original.outputFile || history.latest.sessionId !== original.latest.sessionId) {
      throw new Error("Child recovery identity changed while acquiring lease");
    }
    const validated = validateRecoveryTranscript(options.io.store.readTranscript(history), history);
    if (validated.cwd !== initial.cwd) throw new Error("Child recovery cwd changed while acquiring lease");
    config.signal?.throwIfAborted();
    const manager = options.io.open(history.outputFile!);
    if (manager.getSessionId() !== history.latest.sessionId || manager.getCwd() !== validated.cwd
      || manager.getSessionFile() !== history.outputFile) throw new Error("Opened child identity does not match validated transcript");
    initialized = true;
    const session = await options.createSession({
      snapshot: { ...snapshot, parentContext: undefined }, type: history.latest.type, cwd: validated.cwd,
      parentSession: config.parentSession, recovery: { manager, lease }, model: config.model,
      thinkingLevel: config.thinkingLevel,
    });
    const current = requireHistory(id, config, options.io);
    if (config.signal?.aborted) {
      await session.dispose();
      config.signal.throwIfAborted();
    }
    if (current.invocations.at(-1)?.entryId !== history.invocations.at(-1)?.entryId) {
      await session.dispose();
      throw new Error("Parent terminal history changed during recovery initialization");
    }
    return hydrate(history, snapshot, config, options, session);
  } catch (error) {
    // Before execution initialization, opening current v3 data cannot launch work.
    // After initialization starts, uncertain cleanup must keep the ownership marker.
    if (!initialized) lease.release();
    throw error;
  }
}

function requireHistory(id: string, config: AgentSpawnConfig, io: ColdResumeIO): SavedAgentHistory {
  const history = io.store.get(id);
  if (!history) throw new Error(`Agent not found: "${id}" in the current parent branch`);
  if (!io.isEnabled(history.latest.type)) throw new Error("Original agent type is missing or disabled");
  if (history.parent.id !== config.parentSession?.parentSessionId
    || history.parent.file !== config.parentSession.parentSessionFile) throw new Error("Cold resume requires the original parent session");
  return history;
}

function hydrate(history: SavedAgentHistory, snapshot: ParentSnapshot, config: AgentSpawnConfig,
  options: ColdResumeOptions, session: SubagentSession): Subagent {
  const record = history.latest;
  const execution: SubagentExecution = {
    createSubagentSession: options.createSession, snapshot, prompt: "", baseCwd: snapshot.cwd,
    observer: options.observer, getRunConfig: options.getRunConfig,
    parentSession: config.parentSession, model: config.model, thinkingLevel: config.thinkingLevel,
    maxTurns: Math.min(record.maxTurns, config.maxTurns ?? record.maxTurns),
    wrapUpTurns: Math.min(record.wrapUpTurns, config.wrapUpTurns ?? record.wrapUpTurns),
    maxDurationSeconds: Math.min(record.maxDurationSeconds, config.maxDurationSeconds ?? record.maxDurationSeconds),
  };
  return new Subagent({
    id: record.id, type: record.type, description: record.description, invocation: config.invocation,
    invocationIndex: record.invocationIndex, recoveredSession: session,
    sessionIdentity: { sessionId: record.sessionId!, outputFile: history.outputFile }, execution,
    state: new SubagentState({
      phase: "terminal", outcome: record.outcome, result: record.result, error: record.error,
      startedAt: record.startedAt, completedAt: record.completedAt,
      toolUses: record.lifetimeToolUses, lifetimeUsage: record.lifetimeUsage,
      invocationToolUses: record.invocationToolUses, invocationUsage: record.invocationUsage,
      invocationTurnCount: record.invocationTurnCount, lifetimeTurnCount: record.lifetimeTurnCount,
    }),
  });
}
