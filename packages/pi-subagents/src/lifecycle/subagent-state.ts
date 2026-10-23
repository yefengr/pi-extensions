/**
 * subagent-state.ts — SubagentState value object: lifecycle phase/outcome, metrics, and live activity.
 *
 * Owns the passive, readable state of a subagent — phase, outcome, result, error,
 * timestamps, lifetime and current-invocation metrics, compactionCount, and
 * live-activity fields (invocation/lifetime turn counts, activeTools, responseText) — together with the transition
 * methods (markRunning, markCompleted, …), accumulation methods
 * (incrementToolUses, addUsage, incrementCompactions), and live-activity
 * transition methods (incrementTurnCount, addActiveTool, removeActiveTool,
 * resetResponseText, appendResponseText) that mutate them.
 *
 * State is encapsulated behind getters; external code reads through them but
 * mutates only via the transition/accumulation methods. The value object owns
 * all of its own mutations — no field is written from outside.
 *
 * Subagent holds one of these privately and delegates its getters and mutation
 * methods to it. Extracting it lets the lifecycle state machine and the
 * session-event observer be unit-tested without constructing an executor.
 */

import type { LifetimeUsage } from "#src/lifecycle/usage";
import { addUsage } from "#src/lifecycle/usage";

export type SubagentPhase = "queued" | "running" | "terminal";
export type SubagentOutcome =
	| "completed"
	| "turn_limit"
	| "timeout"
	| "queue_timeout"
	| "cancelled"
	| "error";

export function isActivePhase(phase: SubagentPhase): boolean {
	return phase === "running" || phase === "queued";
}

export function isTerminalErrorOutcome(outcome: SubagentOutcome | undefined): boolean {
	return outcome != null && outcome !== "completed";
}

export function isRunningPhase(phase: SubagentPhase): boolean {
	return phase === "running";
}

export interface SubagentStateInit {
	phase?: SubagentPhase;
	outcome?: SubagentOutcome;
	result?: string;
	error?: string;
	/** Whether the agent was stopped before the limiter ever admitted it. */
	stoppedWhileQueued?: boolean;
	startedAt?: number;
	completedAt?: number;
	/** Time the parent collected the outcome; undefined = obligation still open. */
	consumedAt?: number;
	// Stats — seed a populated value without replaying the accumulation methods
	toolUses?: number;
	lifetimeUsage?: LifetimeUsage;
	invocationStartedAt?: number;
	invocationToolUses?: number;
	invocationUsage?: LifetimeUsage;
	compactionCount?: number;
	// Live activity — activeTools is seeded by name (each entry calls addActiveTool)
	invocationTurnCount?: number;
	lifetimeTurnCount?: number;
	activeTools?: string[];
	responseText?: string;
}

export class SubagentState {
	// Execution phase and terminal outcome are orthogonal.
	private _phase: SubagentPhase;
	get phase(): SubagentPhase { return this._phase; }

	private _outcome?: SubagentOutcome;
	get outcome(): SubagentOutcome | undefined { return this._outcome; }

	private _result?: string;
	get result(): string | undefined { return this._result; }

	private _error?: string;
	get error(): string | undefined { return this._error; }

	// Never-started marker — a queued agent stopped before its slot opened has no
	// result, as distinct from a started agent that produced none.
	private _stoppedWhileQueued: boolean;
	get stoppedWhileQueued(): boolean { return this._stoppedWhileQueued; }

	private _startedAt: number;
	get startedAt(): number { return this._startedAt; }

	private _completedAt?: number;
	get completedAt(): number | undefined { return this._completedAt; }

	// Result delivery — whether the parent has collected the outcome (orthogonal to phase).
	private _consumedAt?: number;
	get consumedAt(): number | undefined { return this._consumedAt; }
	get consumed(): boolean { return this._consumedAt != null; }

	// Stats — accumulated via mutation methods, readable via getters
	private _toolUses: number;
	get toolUses(): number { return this._toolUses; }

	private _lifetimeUsage: LifetimeUsage;
	get lifetimeUsage(): Readonly<LifetimeUsage> { return this._lifetimeUsage; }

	private _invocationStartedAt: number;
	get invocationStartedAt(): number { return this._invocationStartedAt; }

	private _invocationToolUses: number;
	get invocationToolUses(): number { return this._invocationToolUses; }

	private _invocationUsage: LifetimeUsage;
	get invocationUsage(): Readonly<LifetimeUsage> { return this._invocationUsage; }

	private _compactionCount: number;
	get compactionCount(): number { return this._compactionCount; }

	// Live activity — invocation values reset on resume; lifetime values do not.
	private _invocationTurnCount: number;
	get invocationTurnCount(): number { return this._invocationTurnCount; }

	private _lifetimeTurnCount: number;
	get lifetimeTurnCount(): number { return this._lifetimeTurnCount; }

	private _activeTools = new Map<string, string>();
	get activeTools(): ReadonlyMap<string, string> { return this._activeTools; }

	private _toolKeySeq = 0;

	private _responseText: string;
	get responseText(): string { return this._responseText; }

	constructor(init: SubagentStateInit = {}) {
		this._phase = init.phase ?? "queued";
		this._outcome = init.outcome;
		this._result = init.result;
		this._error = init.error;
		this._stoppedWhileQueued = init.stoppedWhileQueued ?? false;
		this._startedAt = init.startedAt ?? Date.now();
		this._completedAt = init.completedAt;
		this._consumedAt = init.consumedAt;
		this._toolUses = init.toolUses ?? 0;
		// Copy so later addUsage() calls cannot mutate either caller-owned object.
		this._lifetimeUsage = init.lifetimeUsage
			? { ...init.lifetimeUsage }
			: { input: 0, output: 0, cacheWrite: 0 };
		this._invocationStartedAt = init.invocationStartedAt ?? this._startedAt;
		this._invocationToolUses = init.invocationToolUses ?? this._toolUses;
		this._invocationUsage = init.invocationUsage
			? { ...init.invocationUsage }
			: { ...this._lifetimeUsage };
		this._compactionCount = init.compactionCount ?? 0;
		this._invocationTurnCount = init.invocationTurnCount ?? 0;
		this._lifetimeTurnCount = init.lifetimeTurnCount ?? this._invocationTurnCount;
		this._responseText = init.responseText ?? "";
		for (const name of init.activeTools ?? []) {
			this.addActiveTool(name);
		}
	}

	/** Running or queued — still live. */
	isActive(): boolean {
		return isActivePhase(this._phase);
	}

	/** Terminal outcomes that did not complete normally. */
	isTerminalError(): boolean {
		return isTerminalErrorOutcome(this._outcome);
	}

	/** Actively running (excludes queued). */
	isRunning(): boolean {
		return isRunningPhase(this._phase);
	}

	/** Whether a steer message can be delivered — the agent must be running. */
	canBeSteered(): boolean {
		return isRunningPhase(this._phase);
	}

	/** Increment lifetime and current-invocation tool use counts. */
	incrementToolUses(): void {
		this._toolUses++;
		this._invocationToolUses++;
	}

	/** Accumulate a usage delta into lifetime and current-invocation windows. */
	addUsage(delta: { input: number; output: number; cacheWrite: number }): void {
		addUsage(this._lifetimeUsage, delta);
		addUsage(this._invocationUsage, delta);
	}

	/** Increment compaction count. Called by record-observer on compaction_end. */
	incrementCompactions(): void {
		this._compactionCount++;
	}

	/** Record a completed model turn for both invocation and lifetime metrics. */
	incrementTurnCount(): void {
		this._invocationTurnCount++;
		this._lifetimeTurnCount++;
	}

	/** Record a tool starting. Called by record-observer on tool_execution_start. */
	addActiveTool(toolName: string): void {
		this._activeTools.set(toolName + "_" + (++this._toolKeySeq), toolName);
	}

	/** Remove one active tool by name (first match). Called by record-observer on tool_execution_end. */
	removeActiveTool(toolName: string): void {
		for (const [key, name] of this._activeTools) {
			if (name === toolName) {
				this._activeTools.delete(key);
				break;
			}
		}
	}

	/** Reset the current response text. Called by record-observer on message_start. */
	resetResponseText(): void {
		this._responseText = "";
	}

	/** Append a text delta to the current response text. Called by record-observer on message_update. */
	appendResponseText(delta: string): void {
		this._responseText += delta;
	}

	/** Transition to running phase and set the execution-start timestamp. */
	markRunning(startedAt: number): void {
		this._phase = "running";
		this._outcome = undefined;
		this._startedAt = startedAt;
		this._invocationStartedAt = startedAt;
	}

	markCompleted(result: string, completedAt?: number): void {
		this.markResult("completed", result, completedAt);
	}

	markTurnLimited(result: string, completedAt?: number): void {
		this.markResult("turn_limit", result, completedAt);
	}

	markTimedOut(error: unknown, completedAt?: number): void {
		this.markFailure("timeout", error, completedAt);
	}

	markQueueTimedOut(error: unknown, completedAt?: number): void {
		if (this._phase === "queued") this._stoppedWhileQueued = true;
		this.markFailure("queue_timeout", error, completedAt);
	}

	markCancelled(completedAt?: number): void {
		if (this._phase === "queued") this._stoppedWhileQueued = true;
		this.markFailure("cancelled", "Subagent invocation was cancelled", completedAt);
	}

	markError(error: unknown, completedAt?: number): void {
		this.markFailure("error", error, completedAt);
	}

	/**
	 * Record the parent collected the outcome. Idempotent — keeps the first
	 * collection time (??=), so a re-read does not advance the retention clock.
	 */
	markConsumed(at?: number): void {
		this._consumedAt ??= at ?? Date.now();
	}

	/** Open a new resume invocation while preserving lifetime totals. */
	resetForResume(startedAt: number): void {
		this._phase = "running";
		this._outcome = undefined;
		this._startedAt = startedAt;
		this._invocationStartedAt = startedAt;
		this._invocationToolUses = 0;
		this._invocationUsage = { input: 0, output: 0, cacheWrite: 0 };
		this._invocationTurnCount = 0;
		this._completedAt = undefined;
		this._result = undefined;
		this._error = undefined;
		this._consumedAt = undefined;
		this._stoppedWhileQueued = false;
	}

	private markResult(outcome: "completed" | "turn_limit", result: string, completedAt?: number): void {
		if (!this.isActive()) return;
		this._phase = "terminal";
		this._outcome = outcome;
		this._result = result;
		this._completedAt = completedAt ?? Date.now();
	}

	private markFailure(
		outcome: "timeout" | "queue_timeout" | "cancelled" | "error",
		error: unknown,
		completedAt?: number,
	): void {
		if (!this.isActive()) return;
		this._phase = "terminal";
		this._outcome = outcome;
		this._error = error instanceof Error ? error.message : String(error);
		this._completedAt = completedAt ?? Date.now();
	}
}
