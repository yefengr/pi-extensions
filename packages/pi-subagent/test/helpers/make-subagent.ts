import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import { Subagent, type SubagentExecution } from "#src/lifecycle/subagent";
import type { SubagentSession } from "#src/lifecycle/subagent-session";
import {
	type SubagentOutcome,
	type SubagentPhase,
	SubagentState,
} from "#src/lifecycle/subagent-state";
import type {
	AgentInvocation,
	SubagentInvocationIdentity,
	SubagentType,
} from "#src/types";
import { createSubagentSessionStub, toSubagentSession } from "#test/helpers/mock-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

/**
 * A minimal, mandatory SubagentExecution for tests that build a passive record
 * and never call run(). The factory resolves to a default session stub.
 */
export function makeStubExecution(overrides: Partial<SubagentExecution> = {}): SubagentExecution {
	return {
		createSubagentSession: async (_params: CreateSubagentSessionParams): Promise<SubagentSession> =>
			toSubagentSession(createSubagentSessionStub()),
		snapshot: STUB_SNAPSHOT,
		prompt: "do something",
		baseCwd: "",
		...overrides,
	};
}

export interface TestSubagentOptions {
	id?: string;
	type?: SubagentType;
	description?: string;
	invocation?: AgentInvocation;
	isBackground?: boolean;
	lifecycleInvocation?: SubagentInvocationIdentity;
	/** Defaults to true; set false for explicit no-session lifecycle states. */
	sessionCreated?: boolean;
	sessionId?: string;
	outputFile?: string;
	execution?: SubagentExecution;
	/** Shorthand to set execution.parentSession.toolCallId. Ignored when execution is supplied. */
	toolCallId?: string;
	/** Passive lifecycle state shorthands. */
	phase?: SubagentPhase;
	outcome?: SubagentOutcome;
	result?: string;
	error?: string;
	/** Seed the never-started marker (the agent was stopped before it was admitted). */
	stoppedWhileQueued?: boolean;
	startedAt?: number;
	completedAt?: number;
	/** Seed the consumed-outcome timestamp (undefined = obligation open). */
	consumedAt?: number;
	/** Seed toolUses. */
	toolUses?: number;
	/** Seed lifetimeUsage. */
	lifetimeUsage?: { input: number; output: number; cacheWrite: number };
	invocationStartedAt?: number;
	invocationToolUses?: number;
	invocationUsage?: { input: number; output: number; cacheWrite: number };
	/** Seed compactionCount. */
	compactionCount?: number;
	/**
	 * Set invocationTurnCount/lifetimeTurnCount. Both default to 1; pass a higher
	 * value to simulate multiple turns.
	 * Ignored when `execution` is supplied (maxTurns lives on the execution, not state).
	 */
	invocationTurnCount?: number;
	lifetimeTurnCount?: number;
	/** Seed active tools by name. */
	activeTools?: string[];
	/** Seed responseText. */
	responseText?: string;
	/** Thread resource limits into the stub execution. Ignored when `execution` is supplied. */
	maxTurns?: number;
	wrapUpTurns?: number;
	maxDurationSeconds?: number;
}

export function createTestSubagent(overrides: TestSubagentOptions = {}): Subagent {
	const {
		id,
		type,
		description,
		invocation,
		isBackground,
		lifecycleInvocation,
		sessionCreated,
		sessionId,
		outputFile,
		execution,
		toolCallId,
		toolUses,
		lifetimeUsage,
		invocationStartedAt,
		invocationToolUses,
		invocationUsage,
		compactionCount,
		invocationTurnCount,
		lifetimeTurnCount,
		activeTools,
		responseText,
		maxTurns,
		wrapUpTurns,
		maxDurationSeconds,
		...stateOverrides
	} = overrides;
	const phase = stateOverrides.phase ?? "terminal";
	const outcome = stateOverrides.outcome ?? (phase === "terminal" ? "completed" : undefined);
	const state = new SubagentState({
		phase,
		...(outcome ? { outcome } : {}),
		result: "result" in stateOverrides ? stateOverrides.result : phase === "terminal" ? "All done." : undefined,
		startedAt: 1000,
		completedAt: "completedAt" in stateOverrides ? stateOverrides.completedAt : phase === "terminal" ? 2000 : undefined,
		toolUses: toolUses ?? 3,
		lifetimeUsage: lifetimeUsage ?? { input: 500, output: 500, cacheWrite: 0 },
		invocationTurnCount: invocationTurnCount ?? 1,
		...(invocationStartedAt !== undefined ? { invocationStartedAt } : {}),
		...(invocationToolUses !== undefined ? { invocationToolUses } : {}),
		...(invocationUsage !== undefined ? { invocationUsage } : {}),
		...(compactionCount !== undefined ? { compactionCount } : {}),
		...(lifetimeTurnCount !== undefined ? { lifetimeTurnCount } : {}),
		...(activeTools !== undefined ? { activeTools } : {}),
		...(responseText !== undefined ? { responseText } : {}),
		...stateOverrides,
	});
	return new Subagent({
		id: id ?? "agent-1",
		type: type ?? "general-purpose",
		description: description ?? "Test task",
		invocation,
		isBackground: isBackground ?? true,
		lifecycleInvocation: lifecycleInvocation ?? (toolCallId
			? { kind: "fresh", source: "tool", toolCallId }
			: { kind: "fresh", source: "service" }),
		...((sessionCreated ?? true)
			? {
				sessionIdentity: {
					sessionId: sessionId ?? "child-session-id",
					outputFile: outputFile ?? "/sessions/child.jsonl",
				},
			}
			: {}),
		execution: execution ?? makeStubExecution({
			...(toolCallId ? { parentSession: { toolCallId } } : {}),
			...(maxTurns !== undefined ? { maxTurns } : {}),
			...(wrapUpTurns !== undefined ? { wrapUpTurns } : {}),
			...(maxDurationSeconds !== undefined ? { maxDurationSeconds } : {}),
		}),
		state,
	});
}
