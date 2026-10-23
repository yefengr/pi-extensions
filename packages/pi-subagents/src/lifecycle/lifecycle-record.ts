import type { Subagent } from "#src/lifecycle/subagent";
import type { SubagentOutcome, SubagentPhase } from "#src/lifecycle/subagent-state";
import type { LifetimeUsage } from "#src/lifecycle/usage";

export const SUBAGENT_LIFECYCLE_RECORD_VERSION = 3 as const;

export interface LifecycleUsageV3 {
	input: number;
	output: number;
	cacheWrite: number;
	total: number;
}

export interface SubagentLifecycleDataV3 {
	recordVersion: typeof SUBAGENT_LIFECYCLE_RECORD_VERSION;
	id: string;
	type: string;
	description: string;
	phase: SubagentPhase;
	outcome?: SubagentOutcome;
	isBackground: boolean;
	invocationKind: "fresh" | "resume";
	invocationSource: "tool" | "service";
	invocationIndex: number;
	toolCallId?: string;
	sessionState: "created" | "not-created";
	sessionId?: string;
	outputFile?: string;
	startedAt: number;
	completedAt?: number;
	durationMs: number;
	result?: string;
	error?: string;
	invocationTurnCount: number;
	lifetimeTurnCount: number;
	maxTurns: number;
	wrapUpTurns: number;
	maxDurationSeconds: number;
	invocationToolUses: number;
	invocationUsage: LifecycleUsageV3;
	lifetimeToolUses: number;
	lifetimeUsage: LifecycleUsageV3;
}

export interface SubagentLifecycleRecordV3 extends SubagentLifecycleDataV3 {
	phase: "terminal";
	outcome: SubagentOutcome;
	completedAt: number;
}

/** Build the shared lifecycle-v3 payload used by public events. */
export function buildLifecycleEventData(record: Subagent): SubagentLifecycleDataV3 {
	const completedAt = record.completedAt;
	const session = lifecycleSessionFields(record);
	return {
		recordVersion: SUBAGENT_LIFECYCLE_RECORD_VERSION,
		id: record.id,
		type: record.type,
		description: sanitizeDescription(record.description),
		phase: record.phase,
		...(record.outcome ? { outcome: record.outcome } : {}),
		isBackground: record.isBackground,
		invocationKind: record.lifecycleInvocation.kind,
		invocationSource: record.lifecycleInvocation.source,
		invocationIndex: record.invocationIndex,
		...(record.toolCallId ? { toolCallId: record.toolCallId } : {}),
		...session,
		startedAt: record.invocationStartedAt,
		...(completedAt == null ? {} : { completedAt }),
		durationMs: Math.max(0, (completedAt ?? Date.now()) - record.invocationStartedAt),
		result: record.result,
		error: record.error,
		invocationTurnCount: record.invocationTurnCount,
		lifetimeTurnCount: record.lifetimeTurnCount,
		maxTurns: record.maxTurns,
		wrapUpTurns: record.wrapUpTurns,
		maxDurationSeconds: record.maxDurationSeconds,
		invocationToolUses: record.invocationToolUses,
		invocationUsage: usageWithTotal(record.invocationUsage),
		lifetimeToolUses: record.toolUses,
		lifetimeUsage: usageWithTotal(record.lifetimeUsage),
	};
}

/** Build a persisted terminal record, rejecting unsupported lifecycle states. */
export function buildLifecycleRecord(record: Subagent): SubagentLifecycleRecordV3 {
	assertTerminal(record.phase, record.outcome);
	if (record.completedAt == null) {
		throw new Error(`Lifecycle v3 terminal record ${record.id} is missing completedAt`);
	}
	if (record.sessionState === "not-created" && !allowsMissingSession(record)) {
		throw new Error(
			`Lifecycle v3 ${record.outcome} record ${record.id} cannot omit sessionId`,
		);
	}
	return buildLifecycleEventData(record) as SubagentLifecycleRecordV3;
}

/** Build a non-terminal steer event without inventing a separate invocation. */
export function buildSteerLifecycleEvent(
	record: Subagent,
	instruction: string,
): SubagentLifecycleDataV3 & { instruction: string } {
	return { ...buildLifecycleEventData(record), instruction };
}

function lifecycleSessionFields(
	record: Subagent,
): Pick<SubagentLifecycleDataV3, "sessionState" | "sessionId" | "outputFile"> {
	if (record.sessionState === "not-created") {
		if (record.sessionId || record.outputFile) {
			throw new Error(`Lifecycle v3 record ${record.id} has contradictory session identity`);
		}
		return { sessionState: "not-created" };
	}
	if (!record.sessionId?.trim()) {
		throw new Error(`Lifecycle v3 record ${record.id} is missing sessionId`);
	}
	return {
		sessionState: "created",
		sessionId: record.sessionId,
		...(record.outputFile ? { outputFile: record.outputFile } : {}),
	};
}

function assertTerminal(phase: SubagentPhase, outcome: SubagentOutcome | undefined): void {
	if (phase !== "terminal") {
		throw new Error(`Lifecycle v3 records must be terminal; received phase ${phase}`);
	}
	if (outcome == null) {
		throw new Error("Lifecycle v3 terminal records require an outcome");
	}
}

/**
 * A terminal record may omit the session identity only when no session can
 * exist: failures before session creation, and never-started cancellations or
 * queue timeouts (the agent was stopped while still queued).
 */
function allowsMissingSession(record: Subagent): boolean {
	if (record.outcome === "error") return true;
	return (
		record.stoppedWhileQueued &&
		(record.outcome === "cancelled" || record.outcome === "queue_timeout")
	);
}

function usageWithTotal(usage: Readonly<LifetimeUsage>): LifecycleUsageV3 {
	return {
		input: usage.input,
		output: usage.output,
		cacheWrite: usage.cacheWrite,
		total: usage.input + usage.output + usage.cacheWrite,
	};
}

function sanitizeDescription(description: string): string {
	return description.replace(/[\t\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
}
