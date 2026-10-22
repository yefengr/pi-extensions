/**
 * subagent.ts — Subagent class: identity, lifecycle phase/outcome, and per-subagent behavior.
 *
 * Phase/outcome and stats are delegated to the SubagentState value object; listener
 * lifecycle to RunListeners; workspace prepare/dispose to WorkspaceBracket.
 * Behavior (abort, steer buffering) lives here rather than on SubagentManager.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { debugLog } from "#src/debug";
import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import {
	InvocationControl,
	isInvocationCancelled,
	isInvocationTimeout,
} from "#src/lifecycle/invocation-control";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { RunListeners } from "#src/lifecycle/run-listeners";
import type { SubagentSession, TurnLoopResult } from "#src/lifecycle/subagent-session";
import {
	type SubagentOutcome,
	type SubagentPhase,
	SubagentState,
} from "#src/lifecycle/subagent-state";
import type { LifetimeUsage } from "#src/lifecycle/usage";
import type { WorkspaceProvider } from "#src/lifecycle/workspace";
import { WorkspaceBracket } from "#src/lifecycle/workspace-bracket";
import { subscribeSubagentObserver } from "#src/observation/record-observer";
import type { RunConfig } from "#src/runtime";
import type {
	AgentInvocation,
	CompactionInfo,
	ParentSessionInfo,
	SessionMessage,
	SubagentInvocationIdentity,
	SubagentSessionIdentity,
	SubagentType,
	ThinkingLevel,
} from "#src/types";

/** Per-subagent lifecycle observer — created by SubagentManager for each spawn. */
export interface SubagentLifecycleObserver {
	/** Fires when the subagent transitions to running (inside run(), after markRunning). */
	onStarted?(agent: Subagent): void;
	/** Fires once the session is created — the subagent's subagentSession is now available. */
	onSessionCreated?(agent: Subagent): void;
	/** Fires once when the run completes or fails (for concurrency drain). */
	onRunFinished?(agent: Subagent): void;
	/** Fires once when a resumed run reaches a terminal state. */
	onResumeFinished?(agent: Subagent): void;
	/** Fires on compaction events during the run. */
	onCompacted?(agent: Subagent, info: CompactionInfo): void;
}

export type { SubagentOutcome, SubagentPhase } from "#src/lifecycle/subagent-state";

/**
 * The result of a steer attempt. `Subagent.steer` owns the non-running
 * rejection rule and reports it here, so coordinators switch on the outcome
 * instead of pre-checking phase (tell by id, with outcomes).
 */
export type SteerOutcome =
	| { kind: "delivered" }
	| { kind: "buffered" }
	| { kind: "rejected"; phase: SubagentPhase; outcome?: SubagentOutcome };

/**
 * The execution machinery a Subagent needs to run. A single mandatory
 * collaborator: production (SubagentManager.spawn) always supplies it, so run()
 * needs no "not configured" guards. The genuinely-optional behavior knobs stay
 * optional; the four inputs run() cannot proceed without are required.
 */
export interface SubagentExecution {
	/** Assembly factory that produces a born-complete SubagentSession. */
	createSubagentSession: (params: CreateSubagentSessionParams) => Promise<SubagentSession>;
	/** Immutable spawn-time parent snapshot handed to the session factory. */
	snapshot: ParentSnapshot;
	/** Initial prompt for the turn loop. */
	prompt: string;
	/** Parent working directory handed to a workspace provider's prepare(). */
	baseCwd: string;
	observer?: SubagentLifecycleObserver;
	getRunConfig?: () => RunConfig;
	/** Resolves the registered workspace provider (if any) at run-start. */
	getWorkspaceProvider?: () => WorkspaceProvider | undefined;
	model?: Model<any>;
	maxTurns?: number;
	wrapUpTurns?: number;
	maxDurationSeconds?: number;
	thinkingLevel?: ThinkingLevel;
	parentSession?: ParentSessionInfo;
	signal?: AbortSignal;
}

export interface InvocationLimitOverrides {
	maxTurns?: number;
	wrapUpTurns?: number;
	maxDurationSeconds?: number;
}

export interface ResolvedInvocationLimits {
	maxTurns: number;
	wrapUpTurns: number;
	maxDurationSeconds: number;
	abortGraceSeconds: number;
}

export interface SubagentInit {
	// Identity
	id: string;
	type: SubagentType;
	description: string;
	invocation?: AgentInvocation;
	/** Whether the fresh invocation was dispatched asynchronously. */
	isBackground?: boolean;
	/** Lifecycle identity for the fresh invocation. */
	lifecycleInvocation?: SubagentInvocationIdentity;
	/** Optional stable session identity for hydrated records and test fixtures. */
	sessionIdentity?: SubagentSessionIdentity;

	/** Execution machinery — always supplied; construct-complete, no test fallbacks. */
	execution: SubagentExecution;

	/** Lifecycle phase/outcome and metrics. Defaults to a fresh queued state. */
	state?: SubagentState;
}

export class Subagent {
	// Identity — set once at construction
	readonly id: string;
	readonly type: SubagentType;
	readonly description: string;
	readonly invocation?: AgentInvocation;
	private _isBackground: boolean;
	get isBackground(): boolean { return this._isBackground; }
	private _lifecycleInvocation: SubagentInvocationIdentity;
	private _invocationIndex = 1;
	private _sessionIdentity?: SubagentSessionIdentity;
	get lifecycleInvocation(): Readonly<SubagentInvocationIdentity> { return this._lifecycleInvocation; }
	get invocationIndex(): number { return this._invocationIndex; }
	get sessionId(): string | undefined {
		return this._sessionIdentity?.sessionId ?? this.subagentSession?.sessionId;
	}
	get sessionState(): "created" | "not-created" {
		return this.sessionId ? "created" : "not-created";
	}

	// Lifecycle phase/outcome and metrics — owned by a private value object; getters and
	// mutation methods below delegate to it one line.
	private readonly state: SubagentState;
	get phase(): SubagentPhase { return this.state.phase; }
	get outcome(): SubagentOutcome | undefined { return this.state.outcome; }
	get result(): string | undefined { return this.state.result; }
	get error(): string | undefined { return this.state.error; }
	get stoppedWhileQueued(): boolean { return this.state.stoppedWhileQueued; }
	get startedAt(): number { return this.state.startedAt; }
	get completedAt(): number | undefined { return this.state.completedAt; }
	get consumedAt(): number | undefined { return this.state.consumedAt; }
	get consumed(): boolean { return this.state.consumed; }
	get toolUses(): number { return this.state.toolUses; }
	get lifetimeUsage(): Readonly<LifetimeUsage> { return this.state.lifetimeUsage; }
	get invocationStartedAt(): number { return this.state.invocationStartedAt; }
	get invocationToolUses(): number { return this.state.invocationToolUses; }
	get invocationUsage(): Readonly<LifetimeUsage> { return this.state.invocationUsage; }
	get compactionCount(): number { return this.state.compactionCount; }
	get invocationTurnCount(): number { return this.state.invocationTurnCount; }
	get lifetimeTurnCount(): number { return this.state.lifetimeTurnCount; }
	get activeTools(): ReadonlyMap<string, string> { return this.state.activeTools; }
	get responseText(): string { return this.state.responseText; }
	isActive(): boolean { return this.state.isActive(); }
	isTerminalError(): boolean { return this.state.isTerminalError(); }
	isRunning(): boolean { return this.state.isRunning(); }
	canBeSteered(): boolean { return this.state.canBeSteered(); }
	get maxTurns(): number { return this.currentLimits?.maxTurns ?? this.resolveLimits().maxTurns; }
	get wrapUpTurns(): number { return this.currentLimits?.wrapUpTurns ?? this.resolveLimits().wrapUpTurns; }
	get maxDurationSeconds(): number {
		return this.currentLimits?.maxDurationSeconds ?? this.resolveLimits().maxDurationSeconds;
	}

	private abortController = new AbortController();
	private currentLimits?: ResolvedInvocationLimits;
	/** True until the current invocation has released its caller, including abort grace. */
	private invocationInFlight = false;
	/** True until the underlying child turn loop settles, including any late settlement after grace. */
	private turnLoopInFlight = false;
	private _promise?: Promise<void>;
	/** Handle on the agent's current run — the initial run, or the live resume that replaced it. */
	get promise(): Promise<void> | undefined { return this._promise; }

	private readonly execution: SubagentExecution;
	private readonly listeners = new RunListeners();
	private readonly workspaceBracket: WorkspaceBracket;

	subagentSession?: SubagentSession;

	// Stable session identity is retained after releaseSession() disposes the
	// heavy session so transcript attribution never depends on a live SDK object.
	private _sessionReleased = false;
	/** True once releaseSession() has freed a live session (distinct from never having had one). */
	get sessionReleased(): boolean { return this._sessionReleased; }

	// Steer buffer — messages queued before the session is ready
	private _pendingSteers: string[] = [];
	/** Number of steer messages waiting to be delivered. */
	get pendingSteerCount(): number { return this._pendingSteers.length; }

	/**
	 * Path to the agent's session JSONL file, or undefined if not yet available.
	 * Falls back to the path captured at releaseSession() once the live session is gone.
	 */
	get outputFile(): string | undefined {
		return this.subagentSession?.outputFile ?? this._sessionIdentity?.outputFile;
	}

	/** The parent tool call driving the current fresh/resume invocation. */
	get toolCallId(): string | undefined {
		return this._lifecycleInvocation.toolCallId;
	}

	/** Returns true when a SubagentSession is available (session is ready). */
	isSessionReady(): boolean {
		return this.subagentSession != null;
	}

	/**
	 * Steer a running agent, owning the non-running rejection rule.
	 * Returns a `rejected` outcome (with the observed phase/outcome) when the agent is
	 * not running, a `buffered` outcome when the session is not yet ready, or a
	 * `delivered` outcome once the message reaches the session.
	 */
	async steer(message: string): Promise<SteerOutcome> {
		if (!this.canBeSteered()) {
			return {
				kind: "rejected",
				phase: this.phase,
				...(this.outcome ? { outcome: this.outcome } : {}),
			};
		}
		if (!this.subagentSession) {
			this.queueSteer(message);
			return { kind: "buffered" };
		}
		await this.subagentSession.steer(message);
		return { kind: "delivered" };
	}

	/** Return the session conversation as formatted text, or undefined if no session. */
	getConversation(): string | undefined {
		return this.subagentSession?.getConversation();
	}

	/** Return the session context window utilization (0-100), or null if unavailable. */
	getContextPercent(): number | null {
		return this.subagentSession?.getContextPercent() ?? null;
	}

	/**
	 * Subscribe to session events for live updates (e.g., conversation viewer).
	 * Returns an unsubscribe function, or undefined if no session is available.
	 */
	subscribeToUpdates(fn: (event: AgentSessionEvent) => void): (() => void) | undefined {
		return this.subagentSession?.subscribe(fn);
	}

	/** The session's message history, or an empty array if no session. */
	get messages(): readonly unknown[] {
		return this.subagentSession?.messages ?? [];
	}

	/** The session's message history typed for Pi's session-rendering machinery, or empty if no session. */
	get agentMessages(): readonly SessionMessage[] {
		return this.subagentSession?.agentMessages ?? [];
	}

	/** Resolve a registered tool definition by name, or undefined if no session. */
	getToolDefinition(name: string): ToolDefinition | undefined {
		return this.subagentSession?.getToolDefinition(name);
	}

	constructor(init: SubagentInit) {
		// Identity
		this.id = init.id;
		this.type = init.type;
		this.description = init.description;
		this.invocation = init.invocation;
		this._isBackground = init.isBackground ?? false;
		this._lifecycleInvocation = normalizeInvocationIdentity(
			init.lifecycleInvocation ?? freshInvocationIdentity(init.execution.parentSession?.toolCallId),
			"fresh",
		);
		const parentToolCallId = init.execution.parentSession?.toolCallId;
		if (parentToolCallId != null && this.toolCallId !== parentToolCallId.trim()) {
			throw new Error("Fresh lifecycle toolCallId contradicts parentSession.toolCallId");
		}
		if (init.sessionIdentity) this.captureSessionIdentity(init.sessionIdentity);

		// Lifecycle phase/outcome and metrics — fresh queued state unless one is supplied
		this.state = init.state ?? new SubagentState();

		// Execution machinery — a single mandatory collaborator
		this.execution = init.execution;

		// Per-run lifecycle collaborators
		this.workspaceBracket = new WorkspaceBracket(
			this.execution.getWorkspaceProvider ?? (() => undefined),
		);
	}

	/**
	 * Execute the full agent lifecycle: workspace preparation, session creation
	 * via the factory, observer wiring, the turn loop, workspace disposal, and
	 * phase/outcome transitions.
	 *
	 * Execution is supplied at construction (mandatory), so run() needs no
	 * "not configured" guards. The returned promise always resolves (errors are
	 * captured internally).
	 */
	async run(): Promise<void> {
		this.invocationInFlight = true;
		this.abortController = new AbortController();
		this.currentLimits = this.resolveLimits();
		this.markRunning(Date.now());
		this.execution.observer?.onStarted?.(this);
		this.listeners.wireSignal(this.execution.signal, () => this.abort());

		const control = this.createInvocationControl(this.currentLimits);
		let preparePromise: Promise<string | undefined> | undefined;
		let createPromise: Promise<SubagentSession> | undefined;
		let stage: "prepare" | "create" | "prompt" = "prepare";

		try {
			let cwd: string | undefined;
			if (this.workspaceBracket.hasProvider()) {
				preparePromise = this.workspaceBracket.prepare({
					agentId: this.id,
					agentType: this.type,
					baseCwd: this.execution.baseCwd,
					invocation: this.invocation,
				});
				cwd = await control.waitFor(preparePromise);
			}

			stage = "create";
			createPromise = this.execution.createSubagentSession({
				snapshot: this.execution.snapshot,
				type: this.type,
				cwd,
				parentSession: this.execution.parentSession,
				onSessionCreated: (identity) => this.captureSessionIdentity(identity),
				model: this.execution.model,
				thinkingLevel: this.execution.thinkingLevel,
			});
			this.subagentSession = await control.waitFor(createPromise);
			this.captureSessionIdentity({
				sessionId: this.subagentSession.sessionId,
				outputFile: this.subagentSession.outputFile,
			});

			stage = "prompt";
			this.flushPendingSteers();
			this.listeners.attachObserver(subscribeSubagentObserver(this.subagentSession, this.state, {
				onCompact: (info) => this.execution.observer?.onCompacted?.(this, info),
			}));
			this.execution.observer?.onSessionCreated?.(this);

			const result = await control.waitFor(this.trackTurnLoop(
				this.subagentSession.runTurnLoop(
					this.execution.prompt,
					this.turnLoopOptions(control),
				),
			));
			this.completeRun(result);
		} catch (err) {
			this.handleInvocationFailure(err, false);
			if (stage === "prepare" && preparePromise) this.disposeLateWorkspace(preparePromise);
			if (stage === "create" && createPromise && !this.subagentSession) {
				this.disposeLateSession(createPromise);
			}
		} finally {
			control.dispose();
			this.invocationInFlight = false;
		}
	}

	/**
	 * Start execution immediately (foreground / bypassQueue paths).
	 * Stores the run promise so it is awaitable via the `promise` getter.
	 */
	start(): void {
		this._promise = this.guardedRun();
	}

	/**
	 * Schedule execution through an external concurrency scheduler (the limiter).
	 * Captures the scheduler's promise eagerly, so a still-queued agent is
	 * awaitable via the `promise` getter from spawn — not only once its slot opens.
	 * The guard in guardedRun() makes an abort-while-queued run a no-op when the
	 * slot finally frees.
	 */
	scheduleVia(schedule: (thunk: () => Promise<void>) => Promise<void>): void {
		this._promise = schedule(() => this.guardedRun());
	}

	/**
	 * Run unless the agent left the active set before its slot opened
	 * (e.g. abort-while-queued): a non-queued, non-running phase resolves
	 * immediately without running.
	 */
	private guardedRun(): Promise<void> {
		if (!this.isActive()) return Promise.resolve();
		return this.run();
	}

	/**
	 * Wait until this agent's current run settles.
	 * Resolves immediately when the agent is no longer active or has no run
	 * handle. A queued agent is awaitable because scheduleVia() captures the
	 * limiter promise at spawn, so the wait spans both the queue slot and the
	 * run that follows it.
	 *
	 * When `signal` fires the wait ends early and the agent keeps running: this
	 * is a query, so interrupting it must not cancel the work. Cancelling the
	 * work on a parent interrupt is InterruptHandler's separate decision.
	 */
	async waitUntilSettled(signal: AbortSignal): Promise<void> {
		const run = this._promise;
		if (!run || !this.isActive()) return;
		await settleOrAbort(run, signal);
	}

	/**
	 * Resume an existing session with a new prompt, managing the observer
	 * subscription lifecycle internally (same wiring as run()).
	 *
	 * Requires an existing SubagentSession (set when the original run created it).
	 * The returned promise always resolves (errors are captured internally) and is
	 * published as the `promise` getter, so waiters track the resume rather than
	 * the settled handle of the original run.
	 * The parent signal flows straight through to resumeTurnLoop — resume does not
	 * route through this.abortController.
	 */
	resume(
		prompt: string,
		invocation: SubagentInvocationIdentity,
		limits?: InvocationLimitOverrides,
		signal?: AbortSignal,
	): Promise<void> {
		const subagentSession = this.subagentSession;
		if (!subagentSession) {
			// Rejection, not a throw: this method is not async, and a synchronous
			// throw would escape a caller's `.rejects` assertion.
			return Promise.reject(new Error("Subagent not configured for resume — missing session"));
		}

		if (this.isActive()) {
			return Promise.reject(new Error(`Cannot resume active subagent ${this.id}`));
		}
		if (this.invocationInFlight || this.turnLoopInFlight) {
			return Promise.reject(
				new Error(`Cannot resume subagent ${this.id}: previous invocation is still settling`),
			);
		}
		let normalizedInvocation: SubagentInvocationIdentity;
		try {
			normalizedInvocation = normalizeInvocationIdentity(invocation, "resume");
		} catch (err) {
			return Promise.reject(err);
		}
		this._lifecycleInvocation = normalizedInvocation;
		this._isBackground = false;
		this._invocationIndex++;
		this._promise = this.runResume(subagentSession, prompt, limits, signal);
		return this._promise;
	}

	/** The resume body. Always resolves — errors become explicit terminal outcomes. */
	private async runResume(
		subagentSession: SubagentSession,
		prompt: string,
		limits?: InvocationLimitOverrides,
		signal?: AbortSignal,
	): Promise<void> {
		this.invocationInFlight = true;
		this.abortController = new AbortController();
		this.currentLimits = this.resolveLimits(limits);
		this.resetForResume(Date.now());
		this.listeners.wireSignal(signal, () => this.abort());
		this.listeners.attachObserver(subscribeSubagentObserver(subagentSession, this.state, {
			onCompact: (info) => this.execution.observer?.onCompacted?.(this, info),
		}));
		const control = this.createInvocationControl(this.currentLimits);

		try {
			const result = await control.waitFor(
				this.trackTurnLoop(subagentSession.resumeTurnLoop(prompt, this.turnLoopOptions(control))),
			);
			this.completeResume(result);
		} catch (err) {
			this.handleInvocationFailure(err, true);
		} finally {
			control.dispose();
			this.invocationInFlight = false;
		}
	}

	/** Terminate a resume and publish the current invocation outcome. */
	completeResume(result: TurnLoopResult): void {
		this.applyTurnLoopResult(result, false);
		this.listeners.release();
		this.execution.observer?.onResumeFinished?.(this);
	}

	/** Terminate a resume as errored. */
	failResume(err: unknown): void {
		this.markError(err);
		this.listeners.release();
		this.execution.observer?.onResumeFinished?.(this);
	}

	/** Transition to running phase and set startedAt. */
	markRunning(startedAt: number): void {
		this.state.markRunning(startedAt);
	}

	/**
	 * Transition to completed state.
	 * Always sets result and completedAt (??=). Only transitions an active phase.
	 */
	markCompleted(result: string, completedAt?: number): void {
		this.state.markCompleted(result, completedAt);
	}

	markTurnLimited(result: string, completedAt?: number): void {
		this.state.markTurnLimited(result, completedAt);
	}

	markTimedOut(error: unknown, completedAt?: number): void {
		this.state.markTimedOut(error, completedAt);
	}

	markQueueTimedOut(error: unknown, completedAt?: number): void {
		this.state.markQueueTimedOut(error, completedAt);
	}

	markCancelled(completedAt?: number): void {
		this.state.markCancelled(completedAt);
	}

	markError(error: unknown, completedAt?: number): void {
		this.state.markError(error, completedAt);
	}

	/** Record the parent collected this agent's outcome. Idempotent. */
	markConsumed(at?: number): void {
		this.state.markConsumed(at);
	}

	/**
	 * Stop an agent that never started, then notify like every other terminal
	 * transition. No listener release: nothing is wired before run().
	 * The record leaves the active set here, so the thunk the limiter runs when
	 * the slot finally frees no-ops on guardedRun()'s guard — one notification.
	 */
	stopQueued(): void {
		this.state.markCancelled();
		this.execution.observer?.onRunFinished?.(this);
	}

	queueTimedOut(timeoutMs: number): void {
		// The limiter cannot remove one pending entry. A queued cancellation may
		// therefore leave its timer armed; ignore that later timeout so it cannot
		// publish a second terminal notification.
		if (this.phase !== "queued") return;
		this.state.markQueueTimedOut(
			`Subagent queue wait timed out after ${Math.ceil(timeoutMs / 1000)} seconds`,
		);
		this.execution.observer?.onRunFinished?.(this);
	}

	/** Cancel the current invocation and release any non-cooperative waiter. */
	abort(): boolean {
		if (!this.isRunning()) return false;
		this.markCancelled();
		this.abortController.abort();
		void this.subagentSession?.abort();
		return true;
	}

	/**
	 * Buffer a steer message for delivery once the session is ready.
	 * Called internally from steer() before the session is ready.
	 */
	private queueSteer(message: string): void {
		this._pendingSteers.push(message);
	}

	/**
	 * Flush all buffered steer messages to the session and clear the buffer.
	 * Called once the session is available (inside run()).
	 */
	private flushPendingSteers(): void {
		for (const msg of this._pendingSteers) {
			this.subagentSession?.steer(msg).catch(() => {});
		}
		this._pendingSteers = [];
	}

	/** Reset for resume: running phase, new invocation state, and fresh invocation metrics. */
	resetForResume(startedAt: number): void {
		this.state.resetForResume(startedAt);
		this.listeners.release();
	}

	/** Complete a fresh run, including its workspace bracket. */
	completeRun(result: TurnLoopResult): void {
		this.listeners.release();
		this.applyTurnLoopResult(result, true);
		this.execution.observer?.onRunFinished?.(this);
	}

	private applyTurnLoopResult(result: TurnLoopResult, disposeWorkspace: boolean): void {
		const workspaceResult = disposeWorkspace
			? this.workspaceBracket.dispose({ outcome: result.outcome, description: this.description })
			: "";
		const finalResult = result.responseText + workspaceResult;

		if (result.outcome === "completed") this.markCompleted(finalResult);
		else if (result.outcome === "turn_limit") this.markTurnLimited(finalResult);
		else if (result.outcome === "timeout") this.markTimedOut("Subagent invocation timed out");
		else this.markCancelled();
	}

	/**
	 * Dispose the wrapped session, firing the `disposed` lifecycle event.
	 * Resolves once the child's extensions have shut down; a failing teardown is
	 * swallowed so the caller's remaining cleanup still runs.
	 */
	async disposeSession(): Promise<void> {
		await disposeQuietly(this.subagentSession, "child session dispose");
	}

	/**
	 * Release the heavy session while keeping the record: capture the transcript
	 * pointer, dispose the session (firing `disposed`), clear it, and mark released.
	 * A no-op once the session is gone — the retention sweep may call it repeatedly.
	 *
	 * The record's own state is updated before the teardown is awaited, so a sweep
	 * tick arriving mid-teardown sees a released record rather than starting a
	 * second one.
	 */
	async releaseSession(): Promise<void> {
		const session = this.subagentSession;
		if (!session) return;
		this.captureSessionIdentity({ sessionId: session.sessionId, outputFile: session.outputFile });
		this.subagentSession = undefined;
		this._sessionReleased = true;
		await disposeQuietly(session, "child session release");
	}

	private createInvocationControl(limits: ResolvedInvocationLimits): InvocationControl {
		return new InvocationControl({
			maxDurationMs: limits.maxDurationSeconds * 1000,
			abortGraceMs: limits.abortGraceSeconds * 1000,
			cancelSignal: this.abortController.signal,
			onTimeout: () => {
				this.markTimedOut(
					`Subagent invocation timed out after ${limits.maxDurationSeconds} seconds`,
				);
				void this.subagentSession?.abort();
			},
		});
	}

	/** Keep a late non-cooperative turn loop from being resumed concurrently. */
	private trackTurnLoop<T>(operation: Promise<T>): Promise<T> {
		this.turnLoopInFlight = true;
		void operation.then(
			() => { this.turnLoopInFlight = false; },
			() => { this.turnLoopInFlight = false; },
		);
		return operation;
	}

	private turnLoopOptions(control: InvocationControl) {
		const limits = this.currentLimits ?? this.resolveLimits();
		return {
			maxTurns: limits.maxTurns,
			wrapUpTurns: limits.wrapUpTurns,
			signal: control.signal,
		};
	}

	private resolveLimits(overrides: InvocationLimitOverrides = {}): ResolvedInvocationLimits {
		const runtime = this.execution.getRunConfig?.() ?? DEFAULT_RUN_CONFIG;
		const maxTurns = minPositive(runtime.maxTurns, this.execution.maxTurns, overrides.maxTurns);
		const maxDurationSeconds = minPositive(
			runtime.maxDurationSeconds,
			this.execution.maxDurationSeconds,
			overrides.maxDurationSeconds,
		);
		const requestedWrapUp = overrides.wrapUpTurns ?? this.execution.wrapUpTurns ?? runtime.wrapUpTurns;
		return {
			maxTurns,
			wrapUpTurns: Math.min(Math.max(0, Math.floor(requestedWrapUp)), maxTurns - 1),
			maxDurationSeconds,
			abortGraceSeconds: runtime.abortGraceSeconds,
		};
	}

	private handleInvocationFailure(error: unknown, resumed: boolean): void {
		if (isInvocationTimeout(error) || this.outcome === "timeout") {
			this.markTimedOut(error);
			this.finishExceptionalInvocation("timeout", resumed);
			void this.releaseSession();
			return;
		}
		if (isInvocationCancelled(error) || this.outcome === "cancelled") {
			this.markCancelled();
			this.finishExceptionalInvocation("cancelled", resumed);
			return;
		}
		if (resumed) this.failResume(error);
		else this.failRun(error);
	}

	private finishExceptionalInvocation(status: "timeout" | "cancelled", resumed: boolean): void {
		this.listeners.release();
		if (!resumed) {
			try {
				this.workspaceBracket.dispose({ outcome: status, description: this.description });
			} catch (cleanupErr) {
				debugLog(`workspace dispose on agent ${status}`, cleanupErr);
			}
		}
		if (resumed) this.execution.observer?.onResumeFinished?.(this);
		else this.execution.observer?.onRunFinished?.(this);
	}

	private disposeLateWorkspace(prepare: Promise<string | undefined>): void {
		void prepare.then(
			() => {
				try {
					this.workspaceBracket.dispose({ outcome: this.outcome ?? "error", description: this.description });
				} catch (error) {
					debugLog("late workspace dispose", error);
				}
			},
			(error) => debugLog("late workspace prepare", error),
		);
	}

	private disposeLateSession(create: Promise<SubagentSession>): void {
		void create.then(
			(session) => disposeQuietly(session, "late child session dispose"),
			(error) => debugLog("late child session creation", error),
		);
	}

	private captureSessionIdentity(identity: SubagentSessionIdentity): void {
		if (!identity.sessionId.trim()) {
			throw new Error("Subagent session identity requires a non-empty sessionId");
		}
		if (this._sessionIdentity && this._sessionIdentity.sessionId !== identity.sessionId) {
			throw new Error(
				`Subagent session identity changed from ${this._sessionIdentity.sessionId} to ${identity.sessionId}`,
			);
		}
		this._sessionIdentity = { ...identity };
	}

	/** Fail a run: mark error, release listeners, best-effort workspace dispose, notify observer. */
	failRun(err: unknown): void {
		this.markError(err);
		this.listeners.release();

		try {
			this.workspaceBracket.dispose({ outcome: "error", description: this.description });
		} catch (cleanupErr) { debugLog("workspace dispose on agent error", cleanupErr); }

		this.execution.observer?.onRunFinished?.(this);
	}
}

const DEFAULT_RUN_CONFIG: RunConfig = {
	maxTurns: 30,
	wrapUpTurns: 2,
	maxDurationSeconds: 1800,
	maxQueueWaitSeconds: 900,
	abortGraceSeconds: 5,
};

function minPositive(...values: Array<number | undefined>): number {
	const normalized = values
		.filter((value): value is number => value != null && Number.isFinite(value) && value > 0)
		.map((value) => Math.floor(value));
	return Math.min(...normalized);
}

function freshInvocationIdentity(toolCallId: string | undefined): SubagentInvocationIdentity {
	return toolCallId == null
		? { kind: "fresh", source: "service" }
		: { kind: "fresh", source: "tool", toolCallId };
}

function normalizeInvocationIdentity(
	identity: SubagentInvocationIdentity,
	expectedKind: SubagentInvocationIdentity["kind"],
): SubagentInvocationIdentity {
	if (identity.kind !== expectedKind) {
		throw new Error(`Expected ${expectedKind} invocation identity, received ${identity.kind}`);
	}
	if (identity.source === "tool") {
		if (!identity.toolCallId?.trim()) {
			throw new Error("Tool-driven subagent invocation requires a non-empty toolCallId");
		}
		return { ...identity, toolCallId: identity.toolCallId.trim() };
	}
	if (identity.toolCallId != null) {
		throw new Error("Service-driven subagent invocation must not include toolCallId");
	}
	return { kind: identity.kind, source: "service" };
}

/**
 * Tear a child session down without letting its failure escape.
 * Both teardown paths are cleanup: a child that will not shut down cleanly must
 * not stop the caller from finishing the rest of its own cleanup.
 */
async function disposeQuietly(
	session: SubagentSession | undefined,
	context: string,
): Promise<void> {
	try {
		await session?.dispose();
	} catch (err) {
		debugLog(context, err);
	}
}

/**
 * Settle with `run`, or early when `signal` fires — whichever comes first.
 * The inner controller is the listener-cleanup channel: it detaches the abort
 * listener whichever branch wins, so repeated waits within one parent turn do
 * not accumulate listeners on that turn's signal.
 */
function settleOrAbort(run: Promise<void>, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	const detach = new AbortController();
	const interrupted = new Promise<void>((resolve) => {
		signal.addEventListener("abort", () => { resolve(); }, { once: true, signal: detach.signal });
	});
	return Promise.race([run, interrupted]).finally(() => { detach.abort(); });
}
