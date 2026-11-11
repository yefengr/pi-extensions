import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import {
	GetResultTool,
	type GetResultToolManager,
} from "#src/tools/get-result-tool";
import type { Subagent } from "#src/types";
import { createTestSubagent, makeStubExecution } from "#test/helpers/make-subagent";
import { createMockSession, createSubagentSessionStub, toSubagentSession } from "#test/helpers/mock-session";
import { STUB_CTX } from "#test/helpers/stub-ctx";

const testRegistry = new AgentTypeRegistry(() => new Map());

function makeManager(records: Map<string, Subagent> = new Map()): GetResultToolManager {
	return { getRecord: (id: string) => records.get(id) };
}

async function execute(
	manager: GetResultToolManager,
	params: { agent_id: string; wait?: boolean; verbose?: boolean; timeout_seconds?: number },
	signal: AbortSignal = new AbortController().signal,
) {
	const tool = new GetResultTool(manager, testRegistry);
	return tool.execute("tc-1", params, signal, undefined, STUB_CTX);
}

describe("GetResultTool query deadlines", () => {
	afterEach(() => { vi.useRealTimers(); });

	function queued() {
		const slot = Promise.withResolvers<void>();
		const record = createTestSubagent({ phase: "queued", completedAt: undefined, invocationTurnCount: 0 });
		record.scheduleVia(async (thunk) => { await slot.promise; await thunk(); });
		return { record, slot, manager: makeManager(new Map([[record.id, record]])) };
	}

	it("ends the query at its deadline without cancelling, consuming or changing execution budgets", async () => {
		vi.useFakeTimers();
		const { record, slot, manager } = queued();
		const abort = vi.spyOn(record, "abort");
		const limits = [record.maxTurns, record.maxDurationSeconds];
		const parent = new AbortController();
		let returned = false;
		const pending = execute(manager, { agent_id: record.id, wait: true, timeout_seconds: 2 }, parent.signal)
			.then((result) => { returned = true; return result; });
		await vi.advanceTimersByTimeAsync(1999);
		expect(returned).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect((await pending).content[0].text).toContain("Wait timed out after 2 seconds");
		expect(record.phase).toBe("queued");
		expect(record.consumed).toBe(false);
		expect(abort).not.toHaveBeenCalled();
		expect([record.maxTurns, record.maxDurationSeconds]).toEqual(limits);
		expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
		slot.resolve();
		await record.promise;
		expect(record.outcome).toBe("completed");
		expect(record.consumed).toBe(false);
	});

	it("uses the independent 60 second default", async () => {
		vi.useFakeTimers();
		const { record, slot, manager } = queued();
		const pending = execute(manager, { agent_id: record.id, wait: true });
		await vi.advanceTimersByTimeAsync(60_000);
		expect((await pending).content[0].text).toContain("Wait timed out after 60 seconds");
		slot.resolve();
		await record.promise;
	});

	it("cleans the deadline timer and parent listener on query interruption", async () => {
		vi.useFakeTimers();
		const { record, slot, manager } = queued();
		const parent = new AbortController();
		const pending = execute(manager, { agent_id: record.id, wait: true }, parent.signal);
		parent.abort();
		expect((await pending).content[0].text).toContain("Status: queued");
		expect(vi.getTimerCount()).toBe(0);
		expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
		expect(record.phase).toBe("queued");
		slot.resolve();
		await record.promise;
	});

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 3601])("rejects invalid query timeout %s", async (timeout_seconds) => {
		const record = createTestSubagent();
		const result = await execute(makeManager(new Map([[record.id, record]])), { agent_id: record.id, timeout_seconds });
		expect(result.content[0].text).toContain("timeout_seconds must be an integer");
		expect(record.consumed).toBe(false);
	});
});

describe("GetResultTool", () => {
	it("returns tool definition with correct name", () => {
		const tool = new GetResultTool(makeManager(), testRegistry);
		expect(tool.toToolDefinition().name).toBe("get_subagent_result");
	});

	it("includes promptSnippet", () => {
		const tool = new GetResultTool(makeManager(), testRegistry);
		expect(tool.toToolDefinition().promptSnippet).toBe(
			"Check status and retrieve results from a background agent.",
		);
	});

	it("returns not-found message for unknown agent ID", async () => {
		const result = await execute(makeManager(), { agent_id: "unknown" });
		expect(result.content[0].text).toContain("Agent not found");
	});

	it("returns status and result for completed agent", async () => {
		const records = new Map([["agent-1", createTestSubagent()]]);
		const result = await execute(makeManager(records), { agent_id: "agent-1" });
		const text = result.content[0].text;
		expect(text).toContain("Agent: agent-1");
		expect(text).toContain("completed");
		expect(text).toContain("All done.");
	});

	it("shows running message for in-progress agent", async () => {
		const records = new Map([["agent-1", createTestSubagent({ phase: "running", completedAt: undefined })]]);
		const result = await execute(makeManager(records), { agent_id: "agent-1" });
		expect(result.content[0].text).toContain("still running");
	});

	it("shows error for failed agent", async () => {
		const records = new Map([["agent-1", createTestSubagent({ phase: "terminal", outcome: "error", error: "timeout" })]]);
		const result = await execute(makeManager(records), { agent_id: "agent-1" });
		expect(result.content[0].text).toContain("Error: timeout");
	});

	it("marks the record consumed for a completed agent (pull-delivery edge)", async () => {
		const record = createTestSubagent({ toolCallId: "tc-1" });
		const records = new Map([["agent-1", record]]);
		await execute(makeManager(records), { agent_id: "agent-1" });
		expect(record.consumed).toBe(true);
	});

	it("marks consumed even for a completed agent without a toolCallId", async () => {
		const record = createTestSubagent();
		const records = new Map([["agent-1", record]]);
		await execute(makeManager(records), { agent_id: "agent-1" });
		expect(record.consumed).toBe(true);
	});

	it("does not mark a running agent consumed", async () => {
		const record = createTestSubagent({ phase: "running", completedAt: undefined });
		const records = new Map([["agent-1", record]]);
		await execute(makeManager(records), { agent_id: "agent-1" });
		expect(record.consumed).toBe(false);
	});

	it("waits for promise when wait=true and agent is running", async () => {
		const sessionStub = createSubagentSessionStub();
		sessionStub.runTurnLoop.mockResolvedValue({ responseText: "Finished after wait.", outcome: "completed", wrappedUp: false });
		const record = createTestSubagent({
			phase: "running",
			completedAt: undefined,
			execution: makeStubExecution({
				createSubagentSession: async () => toSubagentSession(sessionStub),
			}),
		});
		record.start();
		const records = new Map([["agent-1", record]]);
		const result = await execute(makeManager(records), { agent_id: "agent-1", wait: true });
		// After waiting, the record is completed and result is shown
		expect(result.content[0].text).toContain("Finished after wait.");
		expect(record.consumed).toBe(true);
	});

	it("waits for a queued agent when wait=true", async () => {
		const sessionStub = createSubagentSessionStub();
		sessionStub.runTurnLoop.mockResolvedValue({ responseText: "Finished after the queue.", outcome: "completed", wrappedUp: false });
		const record = createTestSubagent({
			phase: "queued",
			completedAt: undefined,
			execution: makeStubExecution({
				createSubagentSession: async () => toSubagentSession(sessionStub),
			}),
		});
		// The limiter admits the agent only after the parent has begun waiting.
		const { promise: slot, resolve: openSlot } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
		record.scheduleVia(async (thunk) => {
			await slot;
			await thunk();
		});
		const records = new Map([["agent-1", record]]);

		const resultPromise = execute(makeManager(records), { agent_id: "agent-1", wait: true });
		openSlot();

		const result = await resultPromise;
		expect(result.content[0].text).toContain("Finished after the queue.");
		expect(record.consumed).toBe(true);
	});

	it("reports the current state when the parent turn is interrupted mid-wait", async () => {
		const sessionStub = createSubagentSessionStub();
		// A run that never settles — only the interrupt can end this wait.
		sessionStub.runTurnLoop.mockReturnValue(new Promise<never>(() => {}));
		const record = createTestSubagent({
			phase: "running",
			completedAt: undefined,
			execution: makeStubExecution({
				createSubagentSession: async () => toSubagentSession(sessionStub),
			}),
		});
		record.start();
		const controller = new AbortController();
		const records = new Map([["agent-1", record]]);

		const resultPromise = execute(makeManager(records), { agent_id: "agent-1", wait: true }, controller.signal);
		controller.abort();

		const result = await resultPromise;
		expect(result.content[0].text).toContain("Status: running");
		// The parent never collected an outcome, so the completion nudge still owes it one.
		expect(record.consumed).toBe(false);
	});

	it("includes conversation when verbose=true", async () => {
		const record = createTestSubagent();
		const stub = createSubagentSessionStub();
		stub.getConversation.mockReturnValue("[User]: hello");
		record.subagentSession = toSubagentSession(stub);
		const records = new Map([["agent-1", record]]);
		const result = await execute(makeManager(records), { agent_id: "agent-1", verbose: true });
		expect(result.content[0].text).toContain("--- Agent Conversation ---");
		expect(result.content[0].text).toContain("[User]: hello");
	});

	it("points to the transcript when verbose is requested but the session was released", async () => {
		const record = createTestSubagent();
		record.subagentSession = toSubagentSession(createSubagentSessionStub(createMockSession(), "/tasks/agent.jsonl"));
		await record.releaseSession();
		const records = new Map([["agent-1", record]]);
		const result = await execute(makeManager(records), { agent_id: "agent-1", verbose: true });
		expect(result.content[0].text).toContain("Full transcript available at: /tasks/agent.jsonl");
		expect(result.content[0].text).not.toContain("--- Agent Conversation ---");
	});
});
