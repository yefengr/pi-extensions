import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import { Subagent, type SubagentExecution, type SubagentLifecycleObserver } from "#src/lifecycle/subagent";
import type { SubagentSession, TurnLoopResult } from "#src/lifecycle/subagent-session";
import { SubagentState, type SubagentStateInit } from "#src/lifecycle/subagent-state";
import type { Workspace, WorkspaceProvider } from "#src/lifecycle/workspace";
import type { RunConfig } from "#src/runtime";
import type {
	AgentInvocation,
	CompactionInfo,
	SubagentInvocationIdentity,
	SubagentType,
} from "#src/types";
import { makeStubExecution } from "#test/helpers/make-subagent";
import { asSubagentSession, createSessionStub, type SessionStub } from "#test/helpers/manager-stubs";
import { createMockSession, emitResumeUsageAndCompaction } from "#test/helpers/mock-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

type SessionFactory = (params: CreateSubagentSessionParams) => Promise<SubagentSession>;

/** Build a factory plus the SubagentSession stub it resolves to. */
function createFactory(): { factory: SessionFactory; stub: SessionStub } {
	const stub = createSessionStub();
	const factory = vi.fn(async (_params: CreateSubagentSessionParams) => asSubagentSession(stub));
	return { factory, stub };
}

/** A factory resolving to a default (completed) SubagentSession stub. */
function defaultFactory(): SessionFactory {
	return createFactory().factory;
}

interface MakeSubagentOptions extends SubagentStateInit {
	id?: string;
	type?: SubagentType;
	description?: string;
	invocation?: AgentInvocation;
	lifecycleInvocation?: SubagentInvocationIdentity;
	execution?: SubagentExecution;
}

/** Construct a Subagent with default identity and a stub execution, overridable per test. */
function makeSubagent(overrides: MakeSubagentOptions = {}): Subagent {
	const { id, type, description, invocation, lifecycleInvocation, execution, ...stateOverrides } = overrides;
	return new Subagent({
		id: id ?? "1",
		type: type ?? "general-purpose",
		description: description ?? "test",
		invocation,
		lifecycleInvocation,
		execution: execution ?? makeStubExecution(),
		state: Object.keys(stateOverrides).length > 0 ? new SubagentState(stateOverrides) : undefined,
	});
}

/** A Subagent wired to a ready session whose messages hold a single user "hi". */
function makeReadySubagent(): { agent: Subagent } {
	const agent = makeSubagent();
	const session = createMockSession();
	session.messages.push({ role: "user", content: "hi" });
	const stub = createSessionStub(session);
	agent.subagentSession = asSubagentSession(stub);
	return { agent };
}

describe("Subagent — constructor", () => {
	it("sets required fields from init", () => {
		const record = makeSubagent({ id: "abc-123", type: "Explore", description: "Find stale TODOs" });
		expect(record.id).toBe("abc-123");
		expect(record.type).toBe("Explore");
		expect(record.description).toBe("Find stale TODOs");
	});

	it("passes through optional identity fields", () => {
		const record = makeSubagent({ invocation: { modelName: "haiku" } });
		expect(record.invocation).toEqual({ modelName: "haiku" });
		// Stats always start at zero — set via mutation methods after construction
		expect(record.toolUses).toBe(0);
		expect(record.compactionCount).toBe(0);
		expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
	});

	it("defaults to a fresh queued state when none is supplied", () => {
		const record = makeSubagent();
		expect(record.phase).toBe("queued");
		expect(record.outcome).toBeUndefined();
		expect(record.result).toBeUndefined();
		expect(record.error).toBeUndefined();
		expect(record.completedAt).toBeUndefined();
		expect(record.promise).toBeUndefined();
		expect(record.subagentSession).toBeUndefined();
	});

	it("accepts an explicit phase/outcome state from the initializer", () => {
		const record = makeSubagent({ phase: "terminal", outcome: "cancelled", stoppedWhileQueued: true });
		expect(record.phase).toBe("terminal");
		expect(record.outcome).toBe("cancelled");
		expect(record.stoppedWhileQueued).toBe(true);
	});

	it("derives fresh tool invocation identity from execution.parentSession.toolCallId", () => {
		const record = makeSubagent({ execution: makeStubExecution({ parentSession: { toolCallId: "tc-42" } }) });
		expect(record.lifecycleInvocation).toEqual({
			kind: "fresh",
			source: "tool",
			toolCallId: "tc-42",
		});
	});

	it("toolCallId is undefined when parentSession.toolCallId is absent", () => {
		const record = makeSubagent({
			execution: makeStubExecution({ parentSession: { parentSessionFile: "/sessions/p.jsonl" } }),
		});
		expect(record.toolCallId).toBeUndefined();
	});

	it("uses explicit service identity when parentSession is absent", () => {
		const record = makeSubagent();
		expect(record.lifecycleInvocation).toEqual({ kind: "fresh", source: "service" });
		expect(record.toolCallId).toBeUndefined();
	});

	it("rejects tool identity without a toolCallId", () => {
		expect(() => makeSubagent({
			lifecycleInvocation: {
				kind: "fresh",
				source: "tool",
			} as unknown as SubagentInvocationIdentity,
		})).toThrow(/requires a non-empty toolCallId/);
	});

	it("rejects resume identity on a newly-created record", () => {
		expect(() => makeSubagent({
			lifecycleInvocation: {
				kind: "resume",
				source: "tool",
				toolCallId: "resume-call",
			},
		})).toThrow(/Expected fresh invocation identity/);
	});

	it("rejects contradictory fresh tool identities", () => {
		expect(() => makeSubagent({
			lifecycleInvocation: {
				kind: "fresh",
				source: "tool",
				toolCallId: "lifecycle-call",
			},
			execution: makeStubExecution({ parentSession: { toolCallId: "parent-call" } }),
		})).toThrow(/contradicts parentSession.toolCallId/);
	});

});

describe("convenience getters", () => {
	describe("live-activity getters", () => {
		it("invocationTurnCount and lifetimeTurnCount default to zero (delegates to SubagentState)", () => {
			const record = makeSubagent();
			expect(record.invocationTurnCount).toBe(0);
			expect(record.lifetimeTurnCount).toBe(0);
		});

		it("activeTools defaults to an empty map (delegates to SubagentState)", () => {
			const record = makeSubagent();
			expect(record.activeTools.size).toBe(0);
		});

		it("responseText defaults to empty string (delegates to SubagentState)", () => {
			const record = makeSubagent();
			expect(record.responseText).toBe("");
		});

		it("budget getters return execution.maxTurns and the matching RunConfig fields", () => {
			const record = makeSubagent({
				execution: makeStubExecution({ maxTurns: 10, wrapUpTurns: 3, maxDurationSeconds: 900 }),
			});
			expect(record.maxTurns).toBe(10);
			expect(record.wrapUpTurns).toBe(3);
			expect(record.maxDurationSeconds).toBe(900);
		});

		it("budget getters fall back to the frozen RunConfig defaults", () => {
			const record = makeSubagent();
			expect(record.maxTurns).toBe(30);
			expect(record.wrapUpTurns).toBe(2);
			expect(record.maxDurationSeconds).toBe(1800);
		});

		it("turn counts reflect state mutations via incrementTurnCount", () => {
			const state = new SubagentState();
			const record = new Subagent({ id: "1", type: "general-purpose", description: "test", execution: makeStubExecution(), state });
			state.incrementTurnCount();
			expect(record.invocationTurnCount).toBe(1);
			expect(record.lifetimeTurnCount).toBe(1);
		});

		it("activeTools reflects state mutations via addActiveTool", () => {
			const state = new SubagentState();
			const record = new Subagent({ id: "1", type: "general-purpose", description: "test", execution: makeStubExecution(), state });
			state.addActiveTool("Read");
			expect(record.activeTools.size).toBe(1);
			expect([...record.activeTools.values()]).toContain("Read");
		});

		it("responseText reflects state mutations via appendResponseText", () => {
			const state = new SubagentState();
			const record = new Subagent({ id: "1", type: "general-purpose", description: "test", execution: makeStubExecution(), state });
			state.appendResponseText("Hello");
			expect(record.responseText).toBe("Hello");
		});
	});

	describe("consumption getters", () => {
		it("consumed defaults to false and consumedAt undefined (delegates to SubagentState)", () => {
			const record = makeSubagent();
			expect(record.consumed).toBe(false);
			expect(record.consumedAt).toBeUndefined();
		});

		it("markConsumed delegates to SubagentState", () => {
			const state = new SubagentState({ phase: "terminal", outcome: "completed" });
			const record = new Subagent({ id: "1", type: "general-purpose", description: "test", execution: makeStubExecution(), state });
			record.markConsumed(5000);
			expect(record.consumed).toBe(true);
			expect(record.consumedAt).toBe(5000);
			expect(state.consumedAt).toBe(5000);
		});
	});

	describe("outputFile", () => {
		it("returns undefined when subagentSession is not set", () => {
			const record = makeSubagent();
			expect(record.outputFile).toBeUndefined();
		});

		it("returns outputFile from subagentSession when set", () => {
			const record = makeSubagent();
			record.subagentSession = asSubagentSession(createSessionStub(createMockSession(), "/path/to/session.jsonl"));
			expect(record.outputFile).toBe("/path/to/session.jsonl");
		});

		it("returns undefined when subagentSession is set but outputFile is undefined", () => {
			const record = makeSubagent();
			record.subagentSession = asSubagentSession(createSessionStub(createMockSession()));
			expect(record.outputFile).toBeUndefined();
		});
	});
});

describe("Subagent — session-encapsulation methods", () => {
	describe("isSessionReady", () => {
		it("returns false when no subagentSession", () => {
			const agent = makeSubagent();
			expect(agent.isSessionReady()).toBe(false);
		});

		it("returns true when subagentSession is set", () => {
			const agent = makeSubagent();
			agent.subagentSession = asSubagentSession(createSessionStub());
			expect(agent.isSessionReady()).toBe(true);
		});
	});

	describe("steer", () => {
		it("rejects with the observed phase and outcome when the agent is not running", async () => {
			const agent = makeSubagent();
			agent.markCompleted("done");
			const stub = createSessionStub();
			agent.subagentSession = asSubagentSession(stub);
			const outcome = await agent.steer("hello");
			expect(outcome).toEqual({ kind: "rejected", phase: "terminal", outcome: "completed" });
			expect(stub.steer).not.toHaveBeenCalled();
			expect(agent.pendingSteerCount).toBe(0);
		});

		it("buffers the message and returns a buffered outcome when the session is not ready", async () => {
			const agent = makeSubagent();
			agent.markRunning(Date.now());
			const outcome = await agent.steer("hello");
			expect(outcome).toEqual({ kind: "buffered" });
			expect(agent.pendingSteerCount).toBe(1);
		});

		it("delivers to the session and returns a delivered outcome when the session is ready", async () => {
			const agent = makeSubagent();
			agent.markRunning(Date.now());
			const stub = createSessionStub();
			agent.subagentSession = asSubagentSession(stub);
			const outcome = await agent.steer("go faster");
			expect(outcome).toEqual({ kind: "delivered" });
			expect(stub.steer).toHaveBeenCalledWith("go faster");
			expect(agent.pendingSteerCount).toBe(0);
		});
	});

	describe("getConversation", () => {
		it("returns undefined when no session", () => {
			const agent = makeSubagent();
			expect(agent.getConversation()).toBeUndefined();
		});

		it("delegates to SubagentSession.getConversation when session is ready", () => {
			const agent = makeSubagent();
			const stub = createSessionStub();
			stub.getConversation.mockReturnValue("[User]: hi");
			agent.subagentSession = asSubagentSession(stub);
			expect(agent.getConversation()).toBe("[User]: hi");
		});
	});

	describe("getContextPercent", () => {
		it("returns null when no session", () => {
			const agent = makeSubagent();
			expect(agent.getContextPercent()).toBeNull();
		});

		it("delegates to SubagentSession.getContextPercent when session is ready", () => {
			const agent = makeSubagent();
			const stub = createSessionStub();
			stub.getContextPercent.mockReturnValue(55);
			agent.subagentSession = asSubagentSession(stub);
			expect(agent.getContextPercent()).toBe(55);
		});
	});

	describe("subscribeToUpdates", () => {
		it("returns undefined when no session", () => {
			const agent = makeSubagent();
			expect(agent.subscribeToUpdates(vi.fn())).toBeUndefined();
		});

		it("delegates to SubagentSession.subscribe when session is ready", () => {
			const agent = makeSubagent();
			const stub = createSessionStub();
			agent.subagentSession = asSubagentSession(stub);
			const fn = vi.fn();
			const unsub = agent.subscribeToUpdates(fn);
			expect(stub.subscribe).toHaveBeenCalledWith(fn);
			expect(typeof unsub).toBe("function");
		});
	});

	describe("messages", () => {
		it("returns empty array when no session", () => {
			const agent = makeSubagent();
			expect(agent.messages).toEqual([]);
		});

		it("delegates to SubagentSession.messages when session is ready", () => {
			const { agent } = makeReadySubagent();
			expect(agent.messages).toEqual([{ role: "user", content: "hi" }]);
		});
	});

	describe("agentMessages", () => {
		it("returns empty array when no session", () => {
			const agent = makeSubagent();
			expect(agent.agentMessages).toEqual([]);
		});

		it("delegates to SubagentSession.agentMessages when session is ready", () => {
			const { agent } = makeReadySubagent();
			expect(agent.agentMessages).toEqual([{ role: "user", content: "hi" }]);
		});
	});

	describe("getToolDefinition", () => {
		it("returns undefined when no session", () => {
			const agent = makeSubagent();
			expect(agent.getToolDefinition("read")).toBeUndefined();
		});

		it("delegates to SubagentSession.getToolDefinition when session is ready", () => {
			const agent = makeSubagent();
			const def = { name: "read" };
			const session = createMockSession({ getToolDefinition: vi.fn(() => def) });
			const stub = createSessionStub(session);
			agent.subagentSession = asSubagentSession(stub);
			expect(agent.getToolDefinition("read")).toBe(def);
		});
	});
});

describe("Subagent — steer buffer", () => {
	it("starts with an empty steer buffer", () => {
		const record = makeSubagent();
		expect(record.pendingSteerCount).toBe(0);
	});
});

describe("Subagent — abort", () => {
	it("returns false and does nothing when not running", () => {
		const record = makeSubagent({ phase: "queued" });
		expect(record.abort()).toBe(false);
		expect(record.phase).toBe("queued");
		expect(record.outcome).toBeUndefined();
	});

	it("marks a running agent cancelled, aborts the session, and returns true", () => {
		const record = makeSubagent({ phase: "running" });
		const stub = createSessionStub();
		record.subagentSession = asSubagentSession(stub);
		expect(record.abort()).toBe(true);
		expect(record.phase).toBe("terminal");
		expect(record.outcome).toBe("cancelled");
		expect(stub.abort).toHaveBeenCalledOnce();
	});

	it("marks cancelled without a session (abort before session creation)", () => {
		const record = makeSubagent({ phase: "running" });
		expect(record.abort()).toBe(true);
		expect(record.phase).toBe("terminal");
		expect(record.outcome).toBe("cancelled");
	});

	it("returns false when already cancelled", () => {
		const record = makeSubagent({ phase: "terminal", outcome: "cancelled" });
		expect(record.abort()).toBe(false);
	});

	it("returns false when completed", () => {
		const record = makeSubagent({ phase: "terminal", outcome: "completed" });
		expect(record.abort()).toBe(false);
	});
});



/** Create a Subagent for completeRun / failRun tests. */
function createCompletionAgent(overrides?: { observer?: SubagentLifecycleObserver }) {
	return {
		record: makeSubagent({
			phase: "running",
			execution: makeStubExecution({ observer: overrides?.observer }),
		}),
	};
}

function createTurnLoopResult(overrides?: Partial<TurnLoopResult>): TurnLoopResult {
	return {
		responseText: "done",
		outcome: "completed",
		wrappedUp: false,
		...overrides,
	};
}

describe("Subagent — completeRun", () => {
	it("transitions to terminal/completed for a normal result", () => {
		const { record } = createCompletionAgent();
		record.completeRun(createTurnLoopResult());
		expect(record.phase).toBe("terminal");
		expect(record.outcome).toBe("completed");
		expect(record.result).toBe("done");
		expect(record.completedAt).toBeDefined();
	});

	it("transitions to cancelled when the outcome is cancelled", () => {
		const { record } = createCompletionAgent();
		record.completeRun(createTurnLoopResult({ outcome: "cancelled" }));
		expect(record.phase).toBe("terminal");
		expect(record.outcome).toBe("cancelled");
		expect(record.result).toBeUndefined();
	});

	it("transitions to turn_limit when the outcome is turn_limit", () => {
		const { record } = createCompletionAgent();
		record.completeRun(createTurnLoopResult({ outcome: "turn_limit" }));
		expect(record.phase).toBe("terminal");
		expect(record.outcome).toBe("turn_limit");
		expect(record.result).toBe("done");
	});

	it("transitions to timeout when the outcome is timeout", () => {
		const { record } = createCompletionAgent();
		record.completeRun(createTurnLoopResult({ outcome: "timeout" }));
		expect(record.phase).toBe("terminal");
		expect(record.outcome).toBe("timeout");
		expect(record.error).toBe("Subagent invocation timed out");
	});

	it("fires observer.onRunFinished on completion", () => {
		const onRunFinished = vi.fn();
		const { record } = createCompletionAgent({ observer: { onRunFinished } });
		record.completeRun(createTurnLoopResult());
		expect(onRunFinished).toHaveBeenCalledOnce();
		expect(onRunFinished).toHaveBeenCalledWith(record);
	});

});

describe("Subagent — failRun", () => {
	it("transitions to a terminal error state", () => {
		const { record } = createCompletionAgent();
		record.failRun(new Error("boom"));
		expect(record.phase).toBe("terminal");
		expect(record.outcome).toBe("error");
		expect(record.error).toBe("boom");
	});

	it("fires observer.onRunFinished on failure", () => {
		const onRunFinished = vi.fn();
		const { record } = createCompletionAgent({ observer: { onRunFinished } });
		record.failRun(new Error("boom"));
		expect(onRunFinished).toHaveBeenCalledOnce();
		expect(onRunFinished).toHaveBeenCalledWith(record);
	});

});

describe("Subagent — stopQueued", () => {
	function createQueuedAgent(observer?: SubagentLifecycleObserver) {
		return makeSubagent({
			phase: "queued",
			execution: makeStubExecution({ observer }),
		});
	}

	it("transitions to terminal/cancelled and records that the agent never started", () => {
		const record = createQueuedAgent();
		record.stopQueued();
		expect(record.phase).toBe("terminal");
		expect(record.outcome).toBe("cancelled");
		expect(record.stoppedWhileQueued).toBe(true);
	});

	it("fires observer.onRunFinished once, like every other terminal transition", () => {
		const onRunFinished = vi.fn();
		const record = createQueuedAgent({ onRunFinished });
		record.stopQueued();
		expect(onRunFinished).toHaveBeenCalledOnce();
		expect(onRunFinished).toHaveBeenCalledWith(record);
	});

	it("ignores a late queue timeout after cancellation", () => {
		const onRunFinished = vi.fn();
		const record = createQueuedAgent({ onRunFinished });
		record.stopQueued();
		record.queueTimedOut(900_000);
		expect(record.outcome).toBe("cancelled");
		expect(onRunFinished).toHaveBeenCalledOnce();
	});

	it("leaves stoppedWhileQueued false for a running agent aborted mid-run", () => {
		const record = makeSubagent({ phase: "running" });
		expect(record.abort()).toBe(true);
		expect(record.phase).toBe("terminal");
		expect(record.outcome).toBe("cancelled");
		expect(record.stoppedWhileQueued).toBe(false);
	});
});

describe("Subagent — disposeSession", () => {
	it("disposes the wrapped SubagentSession", async () => {
		const record = makeSubagent();
		const stub = createSessionStub();
		record.subagentSession = asSubagentSession(stub);
		await record.disposeSession();
		expect(stub.dispose).toHaveBeenCalledOnce();
	});

	it("resolves only after the child's teardown settles", async () => {
		const record = makeSubagent();
		const stub = createSessionStub();
		const teardown = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
		stub.dispose = vi.fn((): Promise<void> => teardown.promise);
		record.subagentSession = asSubagentSession(stub);

		let settled = false;
		const pending = record.disposeSession().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		teardown.resolve();
		await pending;
		expect(settled).toBe(true);
	});

	it("swallows a failing teardown so the caller's cleanup continues", async () => {
		const record = makeSubagent();
		const stub = createSessionStub();
		stub.dispose = vi.fn((): Promise<void> => Promise.reject(new Error("teardown failed")));
		record.subagentSession = asSubagentSession(stub);
		await expect(record.disposeSession()).resolves.toBeUndefined();
	});

	it("is a no-op when no session was created", async () => {
		const record = makeSubagent();
		await expect(record.disposeSession()).resolves.toBeUndefined();
	});
});

describe("Subagent — releaseSession", () => {
	it("disposes the wrapped session and clears it (isSessionReady false)", async () => {
		const record = makeSubagent();
		const stub = createSessionStub(createMockSession(), "/path/to/session.jsonl");
		record.subagentSession = asSubagentSession(stub);
		await record.releaseSession();
		expect(stub.dispose).toHaveBeenCalledOnce();
		expect(record.isSessionReady()).toBe(false);
	});

	it("retains stable session identity after release", async () => {
		const record = makeSubagent();
		record.subagentSession = asSubagentSession(
			createSessionStub(createMockSession(), "/path/to/session.jsonl", "stable-child"),
		);
		await record.releaseSession();
		expect(record.sessionId).toBe("stable-child");
		expect(record.outputFile).toBe("/path/to/session.jsonl");
	});

	it("sets sessionReleased (default false)", async () => {
		const record = makeSubagent();
		expect(record.sessionReleased).toBe(false);
		record.subagentSession = asSubagentSession(createSessionStub(createMockSession(), "/path/to/session.jsonl"));
		await record.releaseSession();
		expect(record.sessionReleased).toBe(true);
	});

	it("clears the session before awaiting teardown, so a racing sweep releases once", async () => {
		const record = makeSubagent();
		const stub = createSessionStub(createMockSession(), "/path/to/session.jsonl");
		const teardown = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
		stub.dispose = vi.fn((): Promise<void> => teardown.promise);
		record.subagentSession = asSubagentSession(stub);

		const first = record.releaseSession();
		expect(record.isSessionReady()).toBe(false);
		const second = record.releaseSession();

		teardown.resolve();
		await Promise.all([first, second]);
		expect(stub.dispose).toHaveBeenCalledOnce();
	});

	it("is a no-op on a second release — does not re-dispose, keeps the captured outputFile", async () => {
		const record = makeSubagent();
		const stub = createSessionStub(createMockSession(), "/path/to/session.jsonl");
		record.subagentSession = asSubagentSession(stub);
		await record.releaseSession();
		await record.releaseSession();
		expect(stub.dispose).toHaveBeenCalledOnce();
		expect(record.outputFile).toBe("/path/to/session.jsonl");
	});

	it("disposeSession after release is a no-op (session already cleared)", async () => {
		const record = makeSubagent();
		const stub = createSessionStub(createMockSession(), "/path/to/session.jsonl");
		record.subagentSession = asSubagentSession(stub);
		await record.releaseSession();
		await record.disposeSession();
		expect(stub.dispose).toHaveBeenCalledOnce();
	});

	it("swallows a failing teardown but still marks the session released", async () => {
		const record = makeSubagent();
		const stub = createSessionStub(createMockSession(), "/path/to/session.jsonl");
		stub.dispose = vi.fn((): Promise<void> => Promise.reject(new Error("teardown failed")));
		record.subagentSession = asSubagentSession(stub);
		await expect(record.releaseSession()).resolves.toBeUndefined();
		expect(record.sessionReleased).toBe(true);
	});

	it("is a no-op when no session was created (sessionReleased stays false)", async () => {
		const record = makeSubagent();
		await expect(record.releaseSession()).resolves.toBeUndefined();
		expect(record.sessionReleased).toBe(false);
	});
});

// ── Agent.run() ──────────────────────────────────────────────────────────────

/** Create a complete Agent ready for run(). */
function createRunnableAgent(overrides?: {
	createSubagentSession?: SessionFactory;
	observer?: SubagentLifecycleObserver;
	getRunConfig?: () => RunConfig;
	maxTurns?: number;
	parentSession?: { toolCallId?: string; parentSessionFile?: string; parentSessionId?: string };
	signal?: AbortSignal;
	baseCwd?: string;
	workspaceProvider?: WorkspaceProvider;
}) {
	const createSubagentSession = overrides?.createSubagentSession ?? defaultFactory();
	const observer = overrides?.observer ?? {};
	const provider = overrides?.workspaceProvider;
	return new Subagent({
		id: "run-1",
		type: "general-purpose",
		description: "run test",
		execution: {
			createSubagentSession,
			observer,
			snapshot: STUB_SNAPSHOT,
			prompt: "do something",
			getRunConfig: overrides?.getRunConfig,
			maxTurns: overrides?.maxTurns,
			parentSession: overrides?.parentSession,
			signal: overrides?.signal,
			baseCwd: overrides?.baseCwd ?? "/base",
			getWorkspaceProvider: provider ? () => provider : undefined,
		},
	});
}

/** Build a Workspace with a recorded dispose. */
function makeWorkspace(cwd: string, disposeResult?: { resultAddendum?: string }): Workspace {
	return { cwd, dispose: vi.fn(() => disposeResult) };
}

/** Build a WorkspaceProvider whose prepare resolves to the given workspace. */
function makeWorkspaceProvider(workspace: Workspace | undefined): WorkspaceProvider {
	return { prepare: vi.fn(async () => workspace) };
}

describe("Subagent.run() — happy path", () => {
	it("transitions through running → terminal/completed", async () => {
		const agent = createRunnableAgent();
		await agent.run();
		expect(agent.phase).toBe("terminal");
		expect(agent.outcome).toBe("completed");
		expect(agent.result).toBe("done");
	});

	it("fires observer callbacks in order: onStarted → onSessionCreated → onRunFinished", async () => {
		const callOrder: string[] = [];
		const observer: SubagentLifecycleObserver = {
			onStarted: () => callOrder.push("started"),
			onSessionCreated: () => callOrder.push("sessionCreated"),
			onRunFinished: () => callOrder.push("runFinished"),
		};
		const agent = createRunnableAgent({ observer });
		await agent.run();
		expect(callOrder).toEqual(["started", "sessionCreated", "runFinished"]);
	});

	it("sets the subagentSession with stable session identity", async () => {
		const agent = createRunnableAgent();
		await agent.run();
		expect(agent.subagentSession).toBeDefined();
		expect(agent.subagentSession!.session).toBeDefined();
		expect(agent.sessionId).toBe("child-session-id");
	});

	it("derives fresh tool invocation identity from the parent call", async () => {
		const agent = createRunnableAgent({ parentSession: { toolCallId: "fresh-call" } });
		await agent.run();
		expect(agent.lifecycleInvocation).toEqual({
			kind: "fresh",
			source: "tool",
			toolCallId: "fresh-call",
		});
		expect(agent.invocationIndex).toBe(1);
	});

	it("flushes pending steers when session is created", async () => {
		const agent = createRunnableAgent();
		// A steer arriving while the agent is running but the session is not yet
		// ready buffers; run() flushes it once the session is created.
		agent.markRunning(Date.now());
		void agent.steer("hurry up");
		expect(agent.pendingSteerCount).toBe(1);
		await agent.run();
		expect(agent.pendingSteerCount).toBe(0);
	});
});

describe("Subagent.run() — workspace provider", () => {
	it("prepares the workspace and threads its cwd into the factory params", async () => {
		const { factory } = createFactory();
		const provider = makeWorkspaceProvider(makeWorkspace("/ws/dir"));
		const agent = createRunnableAgent({ createSubagentSession: factory, workspaceProvider: provider });
		await agent.run();
		const params = (factory as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(params.cwd).toBe("/ws/dir");
	});

	it("calls prepare with the run-start context", async () => {
		const provider = makeWorkspaceProvider(makeWorkspace("/ws/dir"));
		const agent = createRunnableAgent({ workspaceProvider: provider, baseCwd: "/parent" });
		await agent.run();
		expect(provider.prepare).toHaveBeenCalledWith({
			agentId: "run-1",
			agentType: "general-purpose",
			baseCwd: "/parent",
			invocation: undefined,
		});
	});

	it("appends the dispose resultAddendum to the result", async () => {
		const workspace = makeWorkspace("/ws/dir", { resultAddendum: "\n\n---\nsaved to branch foo" });
		const agent = createRunnableAgent({ workspaceProvider: makeWorkspaceProvider(workspace) });
		await agent.run();
		expect(agent.result).toBe("done\n\n---\nsaved to branch foo");
		expect(workspace.dispose).toHaveBeenCalledWith({ outcome: "completed", description: "run test" });
	});

	it("falls back to baseCwd (cwd undefined) when prepare returns undefined", async () => {
		const { factory } = createFactory();
		const provider = makeWorkspaceProvider(undefined);
		const agent = createRunnableAgent({ createSubagentSession: factory, workspaceProvider: provider });
		await agent.run();
		const params = (factory as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(params.cwd).toBeUndefined();
		expect(agent.outcome).toBe("completed");
	});

	it("marks error and fires onRunFinished when prepare rejects", async () => {
		const onRunFinished = vi.fn();
		const provider: WorkspaceProvider = { prepare: vi.fn(() => Promise.reject(new Error("prepare failed"))) };
		const agent = createRunnableAgent({ workspaceProvider: provider, observer: { onRunFinished } });
		await agent.run();
		expect(agent.phase).toBe("terminal");
		expect(agent.outcome).toBe("error");
		expect(agent.error).toBe("prepare failed");
		expect(onRunFinished).toHaveBeenCalledOnce();
	});

	it("disposes with outcome error when the turn loop throws", async () => {
		const { factory, stub } = createFactory();
		stub.runTurnLoop.mockRejectedValue(new Error("turn loop exploded"));
		const workspace = makeWorkspace("/ws/dir", { resultAddendum: "\nshould be discarded" });
		const agent = createRunnableAgent({ createSubagentSession: factory, workspaceProvider: makeWorkspaceProvider(workspace) });
		await agent.run();
		expect(agent.phase).toBe("terminal");
		expect(agent.outcome).toBe("error");
		expect(workspace.dispose).toHaveBeenCalledWith({ outcome: "error", description: "run test" });
		expect(agent.result).toBeUndefined();
	});
});

describe("Subagent.run() — error handling", () => {
	it("transitions to error when the turn loop throws", async () => {
		const { factory, stub } = createFactory();
		stub.runTurnLoop.mockRejectedValue(new Error("turn loop exploded"));
		const agent = createRunnableAgent({ createSubagentSession: factory });
		await agent.run();
		expect(agent.phase).toBe("terminal");
		expect(agent.outcome).toBe("error");
		expect(agent.error).toBe("turn loop exploded");
	});

	it("transitions to error when the factory throws before session creation", async () => {
		const factory: SessionFactory = vi.fn().mockRejectedValue(new Error("creation failed"));
		const agent = createRunnableAgent({ createSubagentSession: factory });
		await agent.run();
		expect(agent.phase).toBe("terminal");
		expect(agent.outcome).toBe("error");
		expect(agent.error).toBe("creation failed");
		expect(agent.sessionState).toBe("not-created");
	});

	it("retains session identity when creation fails after the session exists", async () => {
		const factory: SessionFactory = vi.fn(async (params) => {
			params.onSessionCreated?.({
				sessionId: "created-before-bind-failure",
				outputFile: "/sessions/failed-bind.jsonl",
			});
			throw new Error("bind failed");
		});
		const agent = createRunnableAgent({ createSubagentSession: factory });

		await agent.run();

		expect(agent.phase).toBe("terminal");
		expect(agent.outcome).toBe("error");
		expect(agent.sessionId).toBe("created-before-bind-failure");
		expect(agent.outputFile).toBe("/sessions/failed-bind.jsonl");
	});
});

describe("Subagent.run() — abort signal forwarding", () => {
	it("wires the parent signal so aborting it cancels the run", async () => {
		const parentController = new AbortController();
		const { factory, stub } = createFactory();
		stub.runTurnLoop.mockImplementation(() => {
			parentController.abort();
			return Promise.reject(new Error("aborted"));
		});
		const agent = createRunnableAgent({ createSubagentSession: factory, signal: parentController.signal });
		await agent.run();
		expect(agent.phase).toBe("terminal");
		expect(agent.outcome).toBe("cancelled");
		expect(stub.abort).toHaveBeenCalledOnce();
	});
});

describe("Subagent.run() — RunConfig threading", () => {
	it("passes the RunConfig budget to the turn loop", async () => {
		const { factory, stub } = createFactory();
		const runConfig: RunConfig = {
			maxTurns: 10,
			wrapUpTurns: 3,
			maxDurationSeconds: 1800,
			maxQueueWaitSeconds: 900,
			abortGraceSeconds: 5,
		};
		const agent = createRunnableAgent({ createSubagentSession: factory, getRunConfig: () => runConfig });
		await agent.run();
		const turnOpts = stub.runTurnLoop.mock.calls[0][1];
		expect(turnOpts).toEqual({
			maxTurns: 10,
			wrapUpTurns: 3,
			signal: expect.any(AbortSignal),
		});
	});

	it("caps the turn budget at the execution maxTurns", async () => {
		const { factory, stub } = createFactory();
		const agent = createRunnableAgent({
			createSubagentSession: factory,
			getRunConfig: () => ({
				maxTurns: 30,
				wrapUpTurns: 5,
				maxDurationSeconds: 1800,
				maxQueueWaitSeconds: 900,
				abortGraceSeconds: 5,
			}),
			maxTurns: 4,
		});
		await agent.run();
		expect(stub.runTurnLoop.mock.calls[0][1].maxTurns).toBe(4);
		expect(stub.runTurnLoop.mock.calls[0][1].wrapUpTurns).toBe(3);
	});
});

// ── Subagent.start() ───────────────────────────────────────────────────────────

describe("Subagent.start() — promise encapsulation", () => {
	it("stores a run promise that resolves on completion", async () => {
		const agent = createRunnableAgent();
		agent.start();
		expect(agent.promise).toBeInstanceOf(Promise);
		await agent.promise;
		expect(agent.phase).toBe("terminal");
		expect(agent.outcome).toBe("completed");
	});

	it("promise is undefined before start() is called", () => {
		const agent = createRunnableAgent();
		expect(agent.promise).toBeUndefined();
	});

	it("is a no-op when the record is terminal/cancelled (abort-while-queued guard)", async () => {
		const agent = makeSubagent({ phase: "terminal", outcome: "cancelled", startedAt: 1, completedAt: 1 });
		agent.start();
		await expect(agent.promise).resolves.toBeUndefined();
		expect(agent.phase).toBe("terminal");
		expect(agent.outcome).toBe("cancelled");
	});

	it("is a no-op when the record is terminal/completed", async () => {
		const agent = makeSubagent({ phase: "terminal", outcome: "completed", result: "done", startedAt: 1, completedAt: 2 });
		agent.start();
		await expect(agent.promise).resolves.toBeUndefined();
		expect(agent.phase).toBe("terminal");
		expect(agent.outcome).toBe("completed");
	});
});

describe("Subagent.scheduleVia() — eager promise capture", () => {
	it("exposes the scheduler promise before the run starts (queued-awaitable)", async () => {
		const agent = makeSubagent({ phase: "queued" });
		const { promise: gate, resolve: openSlot } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
		agent.scheduleVia(async (thunk) => {
			await gate;
			await thunk();
		});
		// Promise is captured at schedule time — before the slot opens.
		expect(agent.promise).toBeInstanceOf(Promise);
		expect(agent.phase).toBe("queued");
		openSlot();
		await agent.promise;
		expect(agent.phase).toBe("terminal");
		expect(agent.outcome).toBe("completed");
	});

	it("runs guardedRun as the thunk — abort-while-queued is a no-op", async () => {
		const agent = makeSubagent({ phase: "queued" });
		let thunkRan = false;
		// Stop the agent before the slot opens, then fire the thunk.
		agent.stopQueued();
		agent.scheduleVia(async (thunk) => {
			thunkRan = true;
			await thunk();
		});
		await agent.promise;
		expect(thunkRan).toBe(true);
		expect(agent.phase).toBe("terminal");
		expect(agent.outcome).toBe("cancelled");
	});
});

describe("Subagent.waitUntilSettled()", () => {
	it("resolves immediately for an agent that has no run handle", async () => {
		const agent = makeSubagent({ phase: "queued" });
		await expect(agent.waitUntilSettled(new AbortController().signal)).resolves.toBeUndefined();
	});

	it("resolves immediately for an agent that already left the active set", async () => {
		const agent = makeSubagent({ phase: "terminal", outcome: "completed", result: "done", startedAt: 1, completedAt: 2 });
		agent.start();
		await agent.promise;
		await expect(agent.waitUntilSettled(new AbortController().signal)).resolves.toBeUndefined();
	});

	it("spans the queue slot and the run that follows it", async () => {
		const agent = makeSubagent({ phase: "queued" });
		const { promise: gate, resolve: openSlot } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
		agent.scheduleVia(async (thunk) => {
			await gate;
			await thunk();
		});

		const wait = agent.waitUntilSettled(new AbortController().signal);
		openSlot();
		await wait;

		expect(agent.phase).toBe("terminal");
		expect(agent.outcome).toBe("completed");
	});

	it("ends the wait on interrupt without cancelling the agent", async () => {
		const agent = makeSubagent({ phase: "queued" });
		const { promise: gate, resolve: openSlot } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
		agent.scheduleVia(async (thunk) => {
			await gate;
			await thunk();
		});
		const controller = new AbortController();

		const wait = agent.waitUntilSettled(controller.signal);
		controller.abort();
		await wait;

		// Interrupting the query must not cancel the work: the agent is still
		// queued and still runs once its slot opens.
		expect(agent.phase).toBe("queued");
		openSlot();
		await agent.promise;
		expect(agent.phase).toBe("terminal");
		expect(agent.outcome).toBe("completed");
	});

	it("returns immediately when the signal is already aborted", async () => {
		const agent = makeSubagent({ phase: "queued" });
		agent.scheduleVia(() => new Promise<never>(() => {}));

		await agent.waitUntilSettled(AbortSignal.abort());

		expect(agent.phase).toBe("queued");
	});
});

// ── Agent.resume() ─────────────────────────────────────────────────────────────

const RESUME_INVOCATION = {
	kind: "resume",
	source: "tool",
	toolCallId: "resume-tool-call",
} as const;

/** Create an Agent with a SubagentSession already attached, ready for resume(). */
function createResumableAgent(overrides?: {
	observer?: SubagentLifecycleObserver;
	session?: ReturnType<typeof createMockSession>;
	stub?: SessionStub;
	state?: SubagentState;
	maxTurns?: number;
}) {
	const session = overrides?.session ?? createMockSession();
	const stub = overrides?.stub ?? createSessionStub(session);
	const agent = new Subagent({
		id: "resume-1",
		type: "general-purpose",
		description: "resume test",
		sessionIdentity: { sessionId: stub.sessionId, outputFile: stub.outputFile },
		execution: makeStubExecution({
			observer: overrides?.observer ?? {},
			...(overrides?.maxTurns !== undefined ? { maxTurns: overrides.maxTurns } : {}),
		}),
		state: overrides?.state ?? new SubagentState({ phase: "terminal", outcome: "completed", result: "first" }),
	});
	agent.subagentSession = asSubagentSession(stub);
	return { agent, session, stub };
}

describe("Subagent.resume() — happy path", () => {
	it("transitions to terminal/completed and sets result from the resume response", async () => {
		const { agent } = createResumableAgent();
		await agent.resume("continue", RESUME_INVOCATION);
		expect(agent.phase).toBe("terminal");
		expect(agent.outcome).toBe("completed");
		expect(agent.result).toBe("resumed");
		expect(agent.lifecycleInvocation).toEqual(RESUME_INVOCATION);
		expect(agent.invocationIndex).toBe(2);
		expect(agent.isBackground).toBe(false);
	});

	it("drives resumeTurnLoop with the prompt and the resolved turn-loop budget", async () => {
		const { agent, stub } = createResumableAgent();
		const signal = new AbortController().signal;
		await agent.resume("continue", RESUME_INVOCATION, undefined, signal);
		expect(stub.resumeTurnLoop).toHaveBeenCalledOnce();
		expect(stub.resumeTurnLoop.mock.calls[0][0]).toBe("continue");
		expect(stub.resumeTurnLoop.mock.calls[0][1]).toEqual({
			maxTurns: 30,
			wrapUpTurns: 2,
			signal: expect.any(AbortSignal),
		});
	});

	it("resets transition state before resuming", async () => {
		const { agent } = createResumableAgent();
		await agent.resume("continue", RESUME_INVOCATION);
		expect(agent.error).toBeUndefined();
	});
});

describe("Subagent.resume() — observer lifecycle", () => {
	it("separates resume usage from lifetime totals", async () => {
		const session = createMockSession();
		const stub = createSessionStub(session);
		stub.resumeTurnLoop.mockImplementation(async () => {
			emitResumeUsageAndCompaction(session);
			return { responseText: "second", outcome: "completed", wrappedUp: false };
		});
		const state = new SubagentState({
			phase: "terminal",
			outcome: "completed",
			result: "first",
			toolUses: 2,
			lifetimeUsage: { input: 100, output: 40, cacheWrite: 10 },
		});
		const { agent } = createResumableAgent({ session, stub, state });
		await agent.resume("more", RESUME_INVOCATION);
		expect(agent.lifetimeUsage).toEqual({ input: 170, output: 70, cacheWrite: 15 });
		expect(agent.invocationUsage).toEqual({ input: 70, output: 30, cacheWrite: 5 });
		expect(agent.invocationToolUses).toBe(0);
		expect(agent.compactionCount).toBe(1);
	});

	it("forwards compaction events through observer.onCompacted", async () => {
		const session = createMockSession();
		const seen: Array<{ reason: string; tokensBefore: number }> = [];
		const observer: SubagentLifecycleObserver = {
			onCompacted: (_agent: Subagent, info: CompactionInfo) => seen.push({ reason: info.reason, tokensBefore: info.tokensBefore }),
		};
		const stub = createSessionStub(session);
		stub.resumeTurnLoop.mockImplementation(async () => {
			session.emit({ type: "compaction_end", aborted: false, result: { tokensBefore: 123 }, reason: "threshold" });
			return { responseText: "second", outcome: "completed", wrappedUp: false };
		});
		const { agent } = createResumableAgent({ observer, session, stub });
		await agent.resume("more", RESUME_INVOCATION);
		expect(seen).toEqual([{ reason: "threshold", tokensBefore: 123 }]);
	});

	it("releases the observer subscription after resume completes", async () => {
		const session = createMockSession();
		const { agent } = createResumableAgent({ session });
		await agent.resume("more", RESUME_INVOCATION);
		// Events emitted after resume must not accumulate — subscription released.
		session.emit({ type: "tool_execution_end" });
		expect(agent.toolUses).toBe(0);
	});

	it("fires observer.onResumeFinished once the resume completes", async () => {
		const onResumeFinished = vi.fn();
		const { agent } = createResumableAgent({ observer: { onResumeFinished } });
		await agent.resume("continue", RESUME_INVOCATION);
		expect(onResumeFinished).toHaveBeenCalledExactlyOnceWith(agent);
		expect(agent.outcome).toBe("completed");
	});

	it("fires observer.onResumeFinished when the resume errors", async () => {
		const onResumeFinished = vi.fn();
		const stub = createSessionStub();
		stub.resumeTurnLoop.mockRejectedValue(new Error("resume exploded"));
		const { agent } = createResumableAgent({ observer: { onResumeFinished }, stub });
		await agent.resume("continue", RESUME_INVOCATION);
		expect(onResumeFinished).toHaveBeenCalledExactlyOnceWith(agent);
		expect(agent.outcome).toBe("error");
	});
});

describe("Subagent.resume() — error handling", () => {
	it("transitions to a terminal error without throwing when resumeTurnLoop rejects", async () => {
		const stub = createSessionStub();
		stub.resumeTurnLoop.mockRejectedValue(new Error("resume exploded"));
		const { agent } = createResumableAgent({ stub });
		await agent.resume("more", RESUME_INVOCATION);
		expect(agent.phase).toBe("terminal");
		expect(agent.outcome).toBe("error");
		expect(agent.error).toBe("resume exploded");
	});

	it("releases the observer subscription after resume errors", async () => {
		const session = createMockSession();
		const stub = createSessionStub(session);
		stub.resumeTurnLoop.mockRejectedValue(new Error("boom"));
		const { agent } = createResumableAgent({ session, stub });
		await agent.resume("more", RESUME_INVOCATION);
		session.emit({ type: "tool_execution_end" });
		expect(agent.toolUses).toBe(0);
	});

	it("throws when no session exists", async () => {
		const agent = makeSubagent();
		await expect(agent.resume("more", RESUME_INVOCATION)).rejects.toThrow(/missing session/);
	});

	it("rejects tool-driven resume identity without a toolCallId", async () => {
		const { agent } = createResumableAgent();
		await expect(
			agent.resume(
				"more",
				{ kind: "resume", source: "tool" } as unknown as SubagentInvocationIdentity,
			),
		).rejects.toThrow(/requires a non-empty toolCallId/);
		expect(agent.invocationIndex).toBe(1);
	});

	it("rejects a second resume while the current invocation is active", async () => {
		const { agent, stub } = createResumableAgent();
		const gate = Promise.withResolvers<TurnLoopResult>();
		stub.resumeTurnLoop.mockReturnValue(gate.promise);
		const first = agent.resume("first", RESUME_INVOCATION);

		await expect(
			agent.resume("second", {
				kind: "resume",
				source: "tool",
				toolCallId: "resume-tool-call-2",
			}),
		).rejects.toThrow(/Cannot resume active subagent/);

		gate.resolve({ responseText: "done", outcome: "completed", wrappedUp: false });
		await first;
		expect(agent.invocationIndex).toBe(2);
		expect(agent.toolCallId).toBe("resume-tool-call");
	});

	it("rejects resume while an aborted invocation is still settling", async () => {
		vi.useFakeTimers();
		try {
			const { factory, stub } = createFactory();
			const gate = Promise.withResolvers<TurnLoopResult>();
			stub.runTurnLoop.mockReturnValue(gate.promise);
			const agent = createRunnableAgent({
				createSubagentSession: factory,
				getRunConfig: () => ({
					maxTurns: 30,
					wrapUpTurns: 2,
					maxDurationSeconds: 1800,
					maxQueueWaitSeconds: 900,
					abortGraceSeconds: 1,
				}),
			});
			agent.start();
			await vi.advanceTimersByTimeAsync(0);
			expect(stub.runTurnLoop).toHaveBeenCalledOnce();

			expect(agent.abort()).toBe(true);
			await vi.advanceTimersByTimeAsync(1_000);
			await agent.promise;
			await expect(agent.resume("again", RESUME_INVOCATION)).rejects.toThrow(
				/previous invocation is still settling/,
			);

			gate.resolve({ responseText: "late", outcome: "completed", wrappedUp: false });
			await Promise.resolve();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("Subagent.resume() — budget and reset", () => {
	it("applies the resume limit overrides to the turn loop", async () => {
		const { agent, stub } = createResumableAgent();
		await agent.resume("more", RESUME_INVOCATION, { maxTurns: 4, wrapUpTurns: 1 });
		expect(stub.resumeTurnLoop).toHaveBeenCalledOnce();
		expect(stub.resumeTurnLoop.mock.calls[0][1]).toEqual({
			maxTurns: 4,
			wrapUpTurns: 1,
			signal: expect.any(AbortSignal),
		});
	});

	it("caps the resume budget at the execution maxTurns", async () => {
		const { agent, stub } = createResumableAgent({ maxTurns: 6 });
		await agent.resume("more", RESUME_INVOCATION, { maxTurns: 99 });
		expect(stub.resumeTurnLoop.mock.calls[0][1].maxTurns).toBe(6);
	});

	it("gives every resume a fresh budget, not the previous invocation's remainder", async () => {
		const { agent, stub } = createResumableAgent();
		await agent.resume("more", RESUME_INVOCATION, { maxTurns: 4, wrapUpTurns: 1 });
		await agent.resume("again", {
			kind: "resume",
			source: "tool",
			toolCallId: "resume-tool-call-2",
		});

		// The override applies only to its own invocation; the next resume
		// re-resolves the full default budget instead of inheriting it.
		expect(stub.resumeTurnLoop.mock.calls[0][1]).toEqual({
			maxTurns: 4,
			wrapUpTurns: 1,
			signal: expect.any(AbortSignal),
		});
		expect(stub.resumeTurnLoop.mock.calls[1][1]).toEqual({
			maxTurns: 30,
			wrapUpTurns: 2,
			signal: expect.any(AbortSignal),
		});
	});

	it("cancels the resume when the parent signal aborts", async () => {
		const { agent, stub } = createResumableAgent();
		const controller = new AbortController();
		const gate = Promise.withResolvers<TurnLoopResult>();
		stub.resumeTurnLoop.mockReturnValue(gate.promise);

		const resuming = agent.resume("more", RESUME_INVOCATION, undefined, controller.signal);
		controller.abort();
		gate.resolve({ responseText: "late", outcome: "completed", wrappedUp: false });
		await resuming;

		expect(agent.phase).toBe("terminal");
		expect(agent.outcome).toBe("cancelled");
		expect(stub.abort).toHaveBeenCalledOnce();
	});

	it("resets per-invocation counters while preserving lifetime totals", async () => {
		const session = createMockSession();
		const stub = createSessionStub(session);
		stub.resumeTurnLoop.mockImplementation(async () => {
			session.emit({ type: "turn_end", message: { role: "assistant", content: [] } });
			return { responseText: "second", outcome: "completed", wrappedUp: false };
		});
		const state = new SubagentState({
			phase: "terminal",
			outcome: "completed",
			result: "first",
			toolUses: 5,
			lifetimeUsage: { input: 100, output: 40, cacheWrite: 10 },
			invocationTurnCount: 4,
			lifetimeTurnCount: 4,
			invocationToolUses: 3,
			invocationUsage: { input: 60, output: 20, cacheWrite: 5 },
		});
		const { agent } = createResumableAgent({ session, stub, state });

		await agent.resume("more", RESUME_INVOCATION);

		expect(agent.invocationTurnCount).toBe(1);
		expect(agent.lifetimeTurnCount).toBe(5);
		expect(agent.invocationToolUses).toBe(0);
		expect(agent.invocationUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
		expect(agent.lifetimeUsage).toEqual({ input: 100, output: 40, cacheWrite: 10 });
		expect(agent.result).toBe("second");
		expect(agent.phase).toBe("terminal");
		expect(agent.outcome).toBe("completed");
	});
});

describe("Subagent.resume() — awaitable handle", () => {
	it("republishes the promise getter for the in-flight resume", async () => {
		const { agent, stub } = createResumableAgent();
		agent.start();
		const firstRun = agent.promise;
		await firstRun;
		const { promise: resuming, resolve: finishResume } = Promise.withResolvers<TurnLoopResult>();
		stub.resumeTurnLoop.mockReturnValue(resuming);

		const returned = agent.resume("continue", RESUME_INVOCATION);

		// The getter must track the live resume, not the settled first-run handle.
		expect(agent.promise).not.toBe(firstRun);
		expect(agent.promise).toBe(returned);

		finishResume({ responseText: "resumed late", outcome: "completed", wrappedUp: false });
		await returned;
		expect(agent.phase).toBe("terminal");
		expect(agent.outcome).toBe("completed");
		expect(agent.result).toBe("resumed late");
	});
});

describe("Subagent.run() — invocation timeout", () => {
	const TIMEOUT_RUN_CONFIG: RunConfig = {
		maxTurns: 30,
		wrapUpTurns: 2,
		maxDurationSeconds: 1,
		maxQueueWaitSeconds: 900,
		abortGraceSeconds: 5,
	};

	afterEach(() => {
		vi.useRealTimers();
	});

	it("aborts at the deadline and releases the waiter only after the grace", async () => {
		vi.useFakeTimers();
		const { factory, stub } = createFactory();
		stub.runTurnLoop.mockImplementation(() => new Promise<never>(() => {}));
		const agent = createRunnableAgent({ createSubagentSession: factory, getRunConfig: () => TIMEOUT_RUN_CONFIG });

		let settled = false;
		const run = agent.run().then(() => {
			settled = true;
		});

		// Deadline: the agent flips terminal/timeout and aborts the session, but
		// the waiter is still held for the abort grace.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(agent.phase).toBe("terminal");
		expect(agent.outcome).toBe("timeout");
		expect(stub.abort).toHaveBeenCalledOnce();
		await Promise.resolve();
		expect(settled).toBe(false);

		// Grace elapsed: the waiter is released and the session freed.
		await vi.advanceTimersByTimeAsync(5_000);
		await run;
		expect(settled).toBe(true);
		expect(agent.subagentSession).toBeUndefined();
		expect(stub.dispose).toHaveBeenCalledOnce();
	});

	it("rejects resume once the timeout released the session", async () => {
		vi.useFakeTimers();
		const { factory, stub } = createFactory();
		stub.runTurnLoop.mockImplementation(() => new Promise<never>(() => {}));
		const agent = createRunnableAgent({ createSubagentSession: factory, getRunConfig: () => TIMEOUT_RUN_CONFIG });

		const run = agent.run();
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.advanceTimersByTimeAsync(5_000);
		await run;

		expect(agent.sessionReleased).toBe(true);
		expect(agent.isSessionReady()).toBe(false);
		await expect(agent.resume("more", RESUME_INVOCATION)).rejects.toThrow(/missing session/);
	});
});
