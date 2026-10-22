import { describe, expect, it } from "vitest";
import {
	isActivePhase,
	isRunningPhase,
	isTerminalErrorOutcome,
	type SubagentOutcome,
	type SubagentPhase,
	SubagentState,
} from "#src/lifecycle/subagent-state";

const ALL_PHASES: SubagentPhase[] = ["queued", "running", "terminal"];
const ALL_OUTCOMES: SubagentOutcome[] = [
	"completed",
	"turn_limit",
	"timeout",
	"queue_timeout",
	"cancelled",
	"error",
];

describe("SubagentState — constructor", () => {
	it("defaults phase to 'queued' with no outcome", () => {
		const state = new SubagentState();
		expect(state.phase).toBe("queued");
		expect(state.outcome).toBeUndefined();
	});

	it("defaults startedAt to Date.now() when not provided", () => {
		const before = Date.now();
		const state = new SubagentState();
		const after = Date.now();
		expect(state.startedAt).toBeGreaterThanOrEqual(before);
		expect(state.startedAt).toBeLessThanOrEqual(after);
	});

	it("defaults numeric counters to zero", () => {
		const state = new SubagentState();
		expect(state.toolUses).toBe(0);
		expect(state.compactionCount).toBe(0);
		expect(state.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
		expect(state.invocationToolUses).toBe(0);
		expect(state.invocationUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
	});

	it("defaults live-activity fields", () => {
		const state = new SubagentState();
		expect(state.invocationTurnCount).toBe(0);
		expect(state.lifetimeTurnCount).toBe(0);
		expect(state.responseText).toBe("");
		expect(state.activeTools.size).toBe(0);
	});

	it("passes through optional transition fields", () => {
		const state = new SubagentState({
			phase: "terminal",
			outcome: "completed",
			result: "done",
			error: "oops",
			startedAt: 1000,
			completedAt: 2000,
		});
		expect(state.phase).toBe("terminal");
		expect(state.outcome).toBe("completed");
		expect(state.result).toBe("done");
		expect(state.error).toBe("oops");
		expect(state.startedAt).toBe(1000);
		expect(state.completedAt).toBe(2000);
	});

	it("leaves optional fields undefined when not provided", () => {
		const state = new SubagentState();
		expect(state.result).toBeUndefined();
		expect(state.error).toBeUndefined();
		expect(state.completedAt).toBeUndefined();
	});
});

describe("SubagentState — constructor full-value seeding", () => {
	it("seeds stats fields", () => {
		const state = new SubagentState({
			toolUses: 4,
			lifetimeUsage: { input: 100, output: 200, cacheWrite: 30 },
			invocationToolUses: 2,
			invocationUsage: { input: 10, output: 20, cacheWrite: 3 },
			compactionCount: 2,
		});
		expect(state.toolUses).toBe(4);
		expect(state.lifetimeUsage).toEqual({ input: 100, output: 200, cacheWrite: 30 });
		expect(state.invocationToolUses).toBe(2);
		expect(state.invocationUsage).toEqual({ input: 10, output: 20, cacheWrite: 3 });
		expect(state.compactionCount).toBe(2);
	});

	it("copies lifetimeUsage so mutating the source does not change state", () => {
		const source = { input: 10, output: 20, cacheWrite: 5 };
		const state = new SubagentState({ lifetimeUsage: source });
		source.input = 999;
		expect(state.lifetimeUsage).toEqual({ input: 10, output: 20, cacheWrite: 5 });
	});

	it("seeds live-activity fields", () => {
		const state = new SubagentState({
			invocationTurnCount: 3,
			lifetimeTurnCount: 7,
			activeTools: ["read", "bash"],
			responseText: "partial output",
		});
		expect(state.invocationTurnCount).toBe(3);
		expect(state.lifetimeTurnCount).toBe(7);
		expect([...state.activeTools.values()]).toEqual(["read", "bash"]);
		expect(state.responseText).toBe("partial output");
	});

	it("defaults lifetimeTurnCount to invocationTurnCount when only the invocation is seeded", () => {
		const state = new SubagentState({ invocationTurnCount: 4 });
		expect(state.invocationTurnCount).toBe(4);
		expect(state.lifetimeTurnCount).toBe(4);
	});

	it("seeds activeTools by name and stays removable by name", () => {
		const state = new SubagentState({ activeTools: ["read", "read"] });
		expect(state.activeTools.size).toBe(2);
		state.removeActiveTool("read");
		expect(state.activeTools.size).toBe(1);
		expect([...state.activeTools.values()]).toEqual(["read"]);
	});
});

describe("SubagentState — markRunning", () => {
	it("sets phase to 'running', clears outcome, and begins invocation timing", () => {
		const state = new SubagentState({
			phase: "queued",
			outcome: "error",
			startedAt: 1000,
			invocationStartedAt: 1000,
		});
		state.markRunning(2000);
		expect(state.phase).toBe("running");
		expect(state.outcome).toBeUndefined();
		expect(state.startedAt).toBe(2000);
		expect(state.invocationStartedAt).toBe(2000);
	});
});

describe("SubagentState — markCompleted", () => {
	it("sets phase, outcome, result, and completedAt", () => {
		const state = new SubagentState({ phase: "running" });
		state.markCompleted("all done", 5000);
		expect(state.phase).toBe("terminal");
		expect(state.outcome).toBe("completed");
		expect(state.result).toBe("all done");
		expect(state.completedAt).toBe(5000);
	});

	it("defaults completedAt to Date.now() when not provided", () => {
		const state = new SubagentState({ phase: "running" });
		const before = Date.now();
		state.markCompleted("done");
		const after = Date.now();
		expect(state.completedAt).toBeGreaterThanOrEqual(before);
		expect(state.completedAt).toBeLessThanOrEqual(after);
	});

	it("uses the provided completedAt even when one is already present", () => {
		const state = new SubagentState({ phase: "running", completedAt: 1000 });
		state.markCompleted("done", 9999);
		expect(state.completedAt).toBe(9999);
	});
});

describe("SubagentState — markTurnLimited", () => {
	it("sets phase to terminal with outcome 'turn_limit' and the result", () => {
		const state = new SubagentState({ phase: "running" });
		state.markTurnLimited("hit the cap", 5500);
		expect(state.phase).toBe("terminal");
		expect(state.outcome).toBe("turn_limit");
		expect(state.result).toBe("hit the cap");
		expect(state.completedAt).toBe(5500);
	});

	it("defaults completedAt to Date.now() when not provided", () => {
		const state = new SubagentState({ phase: "running" });
		const before = Date.now();
		state.markTurnLimited("cap");
		const after = Date.now();
		expect(state.completedAt).toBeGreaterThanOrEqual(before);
		expect(state.completedAt).toBeLessThanOrEqual(after);
	});
});

describe("SubagentState — markTimedOut", () => {
	it("sets phase to terminal with outcome 'timeout' and formats the error", () => {
		const state = new SubagentState({ phase: "running" });
		state.markTimedOut(new Error("deadline exceeded"), 6000);
		expect(state.phase).toBe("terminal");
		expect(state.outcome).toBe("timeout");
		expect(state.error).toBe("deadline exceeded");
		expect(state.completedAt).toBe(6000);
	});

	it("formats non-Error values with String()", () => {
		const state = new SubagentState({ phase: "running" });
		state.markTimedOut(42, 6000);
		expect(state.error).toBe("42");
	});
});

describe("SubagentState — markQueueTimedOut", () => {
	it("sets phase to terminal with outcome 'queue_timeout' and marks a queued agent", () => {
		const state = new SubagentState({ phase: "queued" });
		state.markQueueTimedOut(new Error("waited too long"), 6500);
		expect(state.phase).toBe("terminal");
		expect(state.outcome).toBe("queue_timeout");
		expect(state.error).toBe("waited too long");
		expect(state.completedAt).toBe(6500);
		expect(state.stoppedWhileQueued).toBe(true);
	});

	it("does not mark stoppedWhileQueued when the agent had already started", () => {
		const state = new SubagentState({ phase: "running" });
		state.markQueueTimedOut(new Error("late"), 6500);
		expect(state.phase).toBe("terminal");
		expect(state.outcome).toBe("queue_timeout");
		expect(state.stoppedWhileQueued).toBe(false);
	});
});

describe("SubagentState — markCancelled", () => {
	it("sets phase to terminal with outcome 'cancelled' and a fixed message", () => {
		const state = new SubagentState({ phase: "running" });
		state.markCancelled(7000);
		expect(state.phase).toBe("terminal");
		expect(state.outcome).toBe("cancelled");
		expect(state.error).toBe("Subagent invocation was cancelled");
		expect(state.completedAt).toBe(7000);
	});

	it("marks stoppedWhileQueued when a queued agent is cancelled", () => {
		const state = new SubagentState({ phase: "queued" });
		state.markCancelled(7000);
		expect(state.stoppedWhileQueued).toBe(true);
	});

	it("does not mark stoppedWhileQueued when a running agent is cancelled", () => {
		const state = new SubagentState({ phase: "running" });
		state.markCancelled(7000);
		expect(state.stoppedWhileQueued).toBe(false);
	});

	it("defaults completedAt to Date.now() when not provided", () => {
		const state = new SubagentState({ phase: "running" });
		const before = Date.now();
		state.markCancelled();
		const after = Date.now();
		expect(state.completedAt).toBeGreaterThanOrEqual(before);
		expect(state.completedAt).toBeLessThanOrEqual(after);
	});

	it("seeds stoppedWhileQueued from init", () => {
		const state = new SubagentState({ phase: "terminal", outcome: "cancelled", stoppedWhileQueued: true });
		expect(state.stoppedWhileQueued).toBe(true);
	});
});

describe("SubagentState — markError", () => {
	it("sets phase to terminal with outcome 'error' and formats Error objects to .message", () => {
		const state = new SubagentState({ phase: "running" });
		state.markError(new Error("something broke"), 6000);
		expect(state.phase).toBe("terminal");
		expect(state.outcome).toBe("error");
		expect(state.error).toBe("something broke");
		expect(state.completedAt).toBe(6000);
	});

	it("formats non-Error values with String()", () => {
		const state = new SubagentState({ phase: "running" });
		state.markError(42, 6000);
		expect(state.error).toBe("42");
	});
});

describe("SubagentState — terminal transitions are no-ops once terminal", () => {
	const terminalCases: Array<[string, (state: SubagentState) => void]> = [
		["markCompleted", state => state.markCompleted("late", 2000)],
		["markTurnLimited", state => state.markTurnLimited("late", 2000)],
		["markTimedOut", state => state.markTimedOut(new Error("late"), 2000)],
		["markQueueTimedOut", state => state.markQueueTimedOut(new Error("late"), 2000)],
		["markCancelled", state => state.markCancelled(2000)],
		["markError", state => state.markError(new Error("late"), 2000)],
	];

	for (const [name, transition] of terminalCases) {
		it(`${name} leaves an already-terminal state untouched`, () => {
			const state = new SubagentState({
				phase: "terminal",
				outcome: "completed",
				result: "first",
				completedAt: 1000,
			});
			transition(state);
			expect(state.phase).toBe("terminal");
			expect(state.outcome).toBe("completed");
			expect(state.result).toBe("first");
			expect(state.error).toBeUndefined();
			expect(state.completedAt).toBe(1000);
		});
	}
});

describe("SubagentState — incrementToolUses", () => {
	it("increments lifetime and current-invocation counts together", () => {
		const state = new SubagentState();
		expect(state.toolUses).toBe(0);
		expect(state.invocationToolUses).toBe(0);
		state.incrementToolUses();
		state.incrementToolUses();
		expect(state.toolUses).toBe(2);
		expect(state.invocationToolUses).toBe(2);
	});
});

describe("SubagentState — addUsage", () => {
	it("accumulates usage into lifetime and current-invocation windows", () => {
		const state = new SubagentState();
		expect(state.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
		expect(state.invocationUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
		state.addUsage({ input: 100, output: 50, cacheWrite: 10 });
		state.addUsage({ input: 200, output: 80, cacheWrite: 20 });
		expect(state.lifetimeUsage).toEqual({ input: 300, output: 130, cacheWrite: 30 });
		expect(state.invocationUsage).toEqual({ input: 300, output: 130, cacheWrite: 30 });
	});
});

describe("SubagentState — incrementCompactions", () => {
	it("starts at 0 and increments by 1 each call", () => {
		const state = new SubagentState();
		expect(state.compactionCount).toBe(0);
		state.incrementCompactions();
		expect(state.compactionCount).toBe(1);
		state.incrementCompactions();
		expect(state.compactionCount).toBe(2);
	});
});

describe("SubagentState — resetForResume", () => {
	it("sets phase to 'running', clears outcome, and sets a new startedAt", () => {
		const state = new SubagentState({ phase: "terminal", outcome: "completed", startedAt: 1000 });
		state.resetForResume(9000);
		expect(state.phase).toBe("running");
		expect(state.outcome).toBeUndefined();
		expect(state.startedAt).toBe(9000);
	});

	it("clears completedAt, result, error, and stoppedWhileQueued", () => {
		const state = new SubagentState({
			phase: "terminal",
			outcome: "error",
			result: "old result",
			error: "old error",
			completedAt: 5000,
			stoppedWhileQueued: true,
		});
		state.resetForResume(9000);
		expect(state.completedAt).toBeUndefined();
		expect(state.result).toBeUndefined();
		expect(state.error).toBeUndefined();
		expect(state.stoppedWhileQueued).toBe(false);
	});

	it("clears consumedAt so a resumed run creates a new pending outcome", () => {
		const state = new SubagentState({ phase: "terminal", outcome: "completed", consumedAt: 5000 });
		state.resetForResume(9000);
		expect(state.consumedAt).toBeUndefined();
		expect(state.consumed).toBe(false);
	});

	it("opens a zeroed invocation window while preserving lifetime totals", () => {
		const state = new SubagentState({
			phase: "terminal",
			outcome: "completed",
			startedAt: 1000,
			toolUses: 4,
			lifetimeUsage: { input: 90, output: 40, cacheWrite: 5 },
			invocationTurnCount: 3,
			lifetimeTurnCount: 9,
		});
		state.resetForResume(9000);
		expect(state.invocationStartedAt).toBe(9000);
		expect(state.invocationToolUses).toBe(0);
		expect(state.invocationUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
		expect(state.invocationTurnCount).toBe(0);
		expect(state.toolUses).toBe(4);
		expect(state.lifetimeUsage).toEqual({ input: 90, output: 40, cacheWrite: 5 });
		expect(state.lifetimeTurnCount).toBe(9);
	});
});

describe("SubagentState — consumption", () => {
	it("defaults to not consumed", () => {
		const state = new SubagentState();
		expect(state.consumed).toBe(false);
		expect(state.consumedAt).toBeUndefined();
	});

	it("markConsumed sets consumedAt and flips consumed true", () => {
		const state = new SubagentState({ phase: "terminal", outcome: "completed" });
		state.markConsumed(5000);
		expect(state.consumed).toBe(true);
		expect(state.consumedAt).toBe(5000);
	});

	it("markConsumed defaults consumedAt to Date.now() when not provided", () => {
		const state = new SubagentState({ phase: "terminal", outcome: "completed" });
		const before = Date.now();
		state.markConsumed();
		const after = Date.now();
		expect(state.consumedAt).toBeGreaterThanOrEqual(before);
		expect(state.consumedAt).toBeLessThanOrEqual(after);
	});

	it("markConsumed keeps the first collection time (idempotent ??=)", () => {
		const state = new SubagentState({ phase: "terminal", outcome: "completed" });
		state.markConsumed(5000);
		state.markConsumed(9999);
		expect(state.consumedAt).toBe(5000);
	});

	it("seeds consumedAt from the constructor", () => {
		const state = new SubagentState({ phase: "terminal", outcome: "completed", consumedAt: 4200 });
		expect(state.consumed).toBe(true);
		expect(state.consumedAt).toBe(4200);
	});
});

describe("SubagentState — turn counters", () => {
	it("defaults invocation and lifetime turn counts to 0", () => {
		const state = new SubagentState();
		expect(state.invocationTurnCount).toBe(0);
		expect(state.lifetimeTurnCount).toBe(0);
	});

	it("increments both invocation and lifetime counts on each call", () => {
		const state = new SubagentState();
		state.incrementTurnCount();
		expect(state.invocationTurnCount).toBe(1);
		expect(state.lifetimeTurnCount).toBe(1);
		state.incrementTurnCount();
		expect(state.invocationTurnCount).toBe(2);
		expect(state.lifetimeTurnCount).toBe(2);
	});

	it("increments both counters from seeded values", () => {
		const state = new SubagentState({ invocationTurnCount: 2, lifetimeTurnCount: 5 });
		state.incrementTurnCount();
		expect(state.invocationTurnCount).toBe(3);
		expect(state.lifetimeTurnCount).toBe(6);
	});
});

describe("SubagentState — activeTools", () => {
	it("defaults to an empty map", () => {
		const state = new SubagentState();
		expect(state.activeTools.size).toBe(0);
	});

	it("addActiveTool adds a tool by name", () => {
		const state = new SubagentState();
		state.addActiveTool("Read");
		expect(state.activeTools.size).toBe(1);
		expect([...state.activeTools.values()]).toContain("Read");
	});

	it("addActiveTool assigns unique keys for concurrent same-name tools", () => {
		const state = new SubagentState();
		state.addActiveTool("Read");
		state.addActiveTool("Read");
		expect(state.activeTools.size).toBe(2);
		expect([...state.activeTools.values()]).toEqual(["Read", "Read"]);
		const keys = [...state.activeTools.keys()];
		expect(keys[0]).not.toBe(keys[1]);
	});

	it("removeActiveTool removes the first matching tool by name", () => {
		const state = new SubagentState();
		state.addActiveTool("Read");
		state.addActiveTool("Write");
		state.removeActiveTool("Read");
		expect(state.activeTools.size).toBe(1);
		expect([...state.activeTools.values()]).toContain("Write");
		expect([...state.activeTools.values()]).not.toContain("Read");
	});

	it("removeActiveTool removes only one entry when two same-name tools are active", () => {
		const state = new SubagentState();
		state.addActiveTool("Read");
		state.addActiveTool("Read");
		state.removeActiveTool("Read");
		expect(state.activeTools.size).toBe(1);
		expect([...state.activeTools.values()]).toEqual(["Read"]);
	});

	it("removeActiveTool is a no-op when the tool is not active", () => {
		const state = new SubagentState();
		state.addActiveTool("Read");
		state.removeActiveTool("Write"); // not present
		expect(state.activeTools.size).toBe(1);
	});

	it("activeTools getter returns a ReadonlyMap", () => {
		const state = new SubagentState();
		state.addActiveTool("Read");
		const tools = state.activeTools;
		// Verify it's a Map (ReadonlyMap is Map at runtime)
		expect(tools).toBeInstanceOf(Map);
		expect(tools.size).toBe(1);
	});
});

describe("SubagentState — responseText", () => {
	it("defaults to an empty string", () => {
		const state = new SubagentState();
		expect(state.responseText).toBe("");
	});

	it("appendResponseText concatenates text deltas", () => {
		const state = new SubagentState();
		state.appendResponseText("Hello ");
		state.appendResponseText("world");
		expect(state.responseText).toBe("Hello world");
	});

	it("resetResponseText clears accumulated text", () => {
		const state = new SubagentState();
		state.appendResponseText("previous text");
		state.resetResponseText();
		expect(state.responseText).toBe("");
	});

	it("appendResponseText works after a reset", () => {
		const state = new SubagentState();
		state.appendResponseText("first message");
		state.resetResponseText();
		state.appendResponseText("second message");
		expect(state.responseText).toBe("second message");
	});
});

describe("SubagentState — classification predicates", () => {
	const activePhases = new Set<SubagentPhase>(["running", "queued"]);
	const runningPhases = new Set<SubagentPhase>(["running"]);

	describe("exported phase/outcome functions", () => {
		for (const phase of ALL_PHASES) {
			it(`isActivePhase("${phase}") is ${activePhases.has(phase)}`, () => {
				expect(isActivePhase(phase)).toBe(activePhases.has(phase));
			});
			it(`isRunningPhase("${phase}") is ${runningPhases.has(phase)}`, () => {
				expect(isRunningPhase(phase)).toBe(runningPhases.has(phase));
			});
		}

		const terminalErrorOutcomes = new Set<SubagentOutcome>([
			"turn_limit",
			"timeout",
			"queue_timeout",
			"cancelled",
			"error",
		]);
		const allOutcomeInputs: Array<SubagentOutcome | undefined> = [...ALL_OUTCOMES, undefined];
		for (const outcome of allOutcomeInputs) {
			const expected = outcome != null && terminalErrorOutcomes.has(outcome);
			it(`isTerminalErrorOutcome(${String(outcome)}) is ${expected}`, () => {
				expect(isTerminalErrorOutcome(outcome)).toBe(expected);
			});
		}
	});

	describe("instance predicates delegate to phase/outcome", () => {
		for (const phase of ALL_PHASES) {
			it(`phase "${phase}" with no outcome`, () => {
				const state = new SubagentState({ phase });
				expect(state.isActive()).toBe(activePhases.has(phase));
				expect(state.isRunning()).toBe(runningPhases.has(phase));
				expect(state.canBeSteered()).toBe(runningPhases.has(phase));
				expect(state.isTerminalError()).toBe(false);
			});
		}

		for (const outcome of ALL_OUTCOMES) {
			it(`terminal phase with outcome "${outcome}"`, () => {
				const state = new SubagentState({ phase: "terminal", outcome });
				expect(state.isActive()).toBe(false);
				expect(state.isRunning()).toBe(false);
				expect(state.canBeSteered()).toBe(false);
				expect(state.isTerminalError()).toBe(outcome !== "completed");
			});
		}
	});
});
