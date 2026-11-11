import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { AgentTool } from "#src/tools/agent-tool";
import { createToolDeps, createToolDepsWithDisabledBuiltInAgents } from "#test/helpers/make-deps";
import { createTestSubagent } from "#test/helpers/make-subagent";
import { createMockSession, createSubagentSessionStub, toSubagentSession } from "#test/helpers/mock-session";

function makeCtx(overrides: Record<string, unknown> = {}) {
	return {
		ui: { fake: true },
		...overrides,
	} as unknown as ExtensionContext;
}

function makeTool(deps: ReturnType<typeof createToolDeps>) {
	return new AgentTool(deps.manager, deps.runtime, deps.settings, deps.registry, deps.agentDir);
}

async function execute(
	deps: ReturnType<typeof createToolDeps>,
	params: Record<string, unknown>,
	ctx?: ReturnType<typeof makeCtx>,
) {
	return makeTool(deps).execute(
		"tc-1",
		params,
		new AbortController().signal,
		vi.fn(),
		ctx ?? makeCtx(),
	);
}

describe("AgentTool", () => {
	it("returns tool definition with correct name and label", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		expect(def.name).toBe("subagent");
		expect(def.label).toBe("Subagent");
	});

	it("includes promptSnippet", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		expect(def.promptSnippet).toBe(
			"Launch a specialized agent for complex, multi-step tasks.",
		);
	});

	it("exposes integer runtime-budget parameters with the frozen minimums", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		const schema = def.parameters as unknown as {
			properties: Record<string, { type?: string; minimum?: number }>;
		};
		expect(schema.properties.max_turns.type).toBe("integer");
		expect(schema.properties.max_turns.minimum).toBe(1);
		expect(schema.properties.wrap_up_turns.type).toBe("integer");
		expect(schema.properties.wrap_up_turns.minimum).toBe(0);
		expect(schema.properties.max_duration_seconds.type).toBe("integer");
		expect(schema.properties.max_duration_seconds.minimum).toBe(1);
	});

	it("derives type list from registry — includes default agents in description", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		// testRegistry loads the built-in default agent: general-purpose
		expect(def.description).toContain("- general-purpose: General-purpose agent");
	});

	it("lists the built-in agent guidelines in registry order", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		const guidelines = [
			"- Use general-purpose for complex tasks that need file editing.",
		];
		for (const line of guidelines) expect(def.description).toContain(line);
		const positions = guidelines.map((line) => def.description.indexOf(line));
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});

	it("omits the type-list entry and guideline for a disabled built-in", () => {
		const name = "general-purpose";
		const def = makeTool(createToolDepsWithDisabledBuiltInAgents(name)).toToolDefinition();
		expect(def.description).not.toContain(`- ${name}:`);
		expect(def.description).not.toContain(`- Use ${name} for `);
	});

	it("calls registry.reload() on each execute", async () => {
		const deps = createToolDeps();
		const reloadSpy = vi.spyOn(deps.registry, "reload");
		await execute(deps, {
			prompt: "test",
			description: "test",
			subagent_type: "general-purpose",
		});
		expect(reloadSpy).toHaveBeenCalledOnce();
		reloadSpy.mockRestore();
	});

});

describe("AgentTool — resume path", () => {
	it("accepts only explicit background resume and returns the original ID without consumption", async () => {
		const deps = createToolDeps();
		const record = createTestSubagent({ id: "original", phase: "queued" });
		record.subagentSession = toSubagentSession(createSubagentSessionStub());
		deps.manager.getRecord = vi.fn().mockReturnValue(record);
		deps.manager.resume = vi.fn().mockResolvedValue(record);
		const update = vi.fn();
		const result = await makeTool(deps).execute("resume-call", {
			prompt: "continue", description: "resume", resume: "original", run_in_background: true,
		}, undefined, update, makeCtx());
		expect(result.content[0].text).toContain("queued in background");
		expect(result.content[0].text).toContain("Agent ID: original");
		expect(deps.manager.resume).toHaveBeenCalledWith("original", "continue", expect.anything(), expect.anything(), undefined, { runInBackground: true });
		expect(record.consumed).toBe(false);
		expect(update).not.toHaveBeenCalled();
	});

	it.each([false, true])("streams current invocation for cold=%s, awaits the final result and cleans the timer", async (cold) => {
		vi.useFakeTimers();
		try {
			const deps = createToolDeps();
			const record = createTestSubagent({ toolUses: 9, invocationTurnCount: 8, responseText: "old response", activeTools: ["read"] });
			const stub = createSubagentSessionStub();
			const gate = Promise.withResolvers<{ responseText: string; outcome: "completed"; wrappedUp: boolean }>();
			stub.resumeTurnLoop.mockReturnValue(gate.promise);
			record.subagentSession = toSubagentSession(stub);
			let restored = !cold;
			deps.manager.getRecord = vi.fn(() => restored ? record : undefined);
			if (cold) Object.assign(deps.manager, {
				getSavedRecord: vi.fn(() => ({ type: "general-purpose" })),
				restore: vi.fn(async () => { restored = true; return record; }),
			});
			deps.manager.resume = vi.fn(async () => {
				await record.resume("continue", { kind: "resume", source: "tool", toolCallId: "stream" });
				return record;
			});
			const consumed = vi.spyOn(record, "markConsumed");
			const onUpdate = vi.fn();
			const running = makeTool(deps).execute("stream", {
				prompt: "continue", description: "resume", resume: "agent-1",
			}, undefined, onUpdate, makeCtx());
			let returned = false;
			void running.then(() => { returned = true; });
			await vi.advanceTimersByTimeAsync(160);
			expect(returned).toBe(false);
			expect(onUpdate.mock.lastCall?.[0].details).toMatchObject({ toolUses: 0, invocationTurnCount: 0, activity: "Running; no activity observed yet" });
			expect(record.lastProgressAt).toBeUndefined();
			gate.resolve({ responseText: "final resumed answer", outcome: "completed", wrappedUp: false });
			const result = await running;
			expect(result.content[0].text).toBe("final resumed answer");
			expect(consumed).toHaveBeenCalledTimes(1);
			onUpdate.mockClear();
			await vi.advanceTimersByTimeAsync(240);
			expect(onUpdate).not.toHaveBeenCalled();
		} finally { vi.useRealTimers(); }
	});

	it("cleans foreground progress after resume rejection", async () => {
		vi.useFakeTimers();
		try {
			const deps = createToolDeps();
			const record = createTestSubagent();
			record.subagentSession = toSubagentSession(createSubagentSessionStub());
			deps.manager.getRecord = vi.fn(() => record);
			deps.manager.resume = vi.fn().mockRejectedValue(new Error("resume failed"));
			const update = vi.fn();
			const result = await makeTool(deps).execute("failed", { resume: "agent-1", prompt: "next", description: "resume" }, undefined, update, makeCtx());
			expect(result.content[0].text).toContain("resume failed");
			update.mockClear();
			await vi.advanceTimersByTimeAsync(160);
			expect(update).not.toHaveBeenCalled();
			expect(record.consumed).toBe(false);
		} finally { vi.useRealTimers(); }
	});
	it("refuses an already cancelled request before initialization", async () => {
		const deps = createToolDeps();
		const controller = new AbortController();
		controller.abort();
		const result = await makeTool(deps).execute("cancelled", { prompt: "continue", resume: "saved" }, controller.signal, undefined, makeCtx());
		expect(result.content[0].text).toContain("cancelled before initialization");
		expect(deps.manager.getRecord).not.toHaveBeenCalled();
		expect(deps.manager.spawn).not.toHaveBeenCalled();
	});

	it("restores missing in-memory records using the saved original type", async () => {
		const deps = createToolDeps();
		const restored = createTestSubagent();
		restored.subagentSession = toSubagentSession(createSubagentSessionStub());
		deps.manager.getRecord = vi.fn().mockReturnValue(undefined);
		const restore = vi.fn().mockResolvedValue(restored);
		Object.assign(deps.manager, { getSavedRecord: vi.fn(() => ({ type: "general-purpose" })), restore });
		deps.manager.resume = vi.fn().mockResolvedValue(createTestSubagent({ result: "Recovered answer" }));
		const result = await execute(deps, { prompt: "continue", description: "resume", subagent_type: "unrelated", resume: "saved" });
		expect(result.content[0].text).toBe("Recovered answer");
		expect(restore).toHaveBeenCalledWith("saved", expect.anything(), expect.objectContaining({ signal: expect.any(AbortSignal) }));
		expect(deps.manager.resume).toHaveBeenCalledWith("saved", "continue", expect.objectContaining({ kind: "resume" }), expect.anything(), expect.any(AbortSignal));
	});

	it("reports cold-resume refusal without creating an invocation", async () => {
		const deps = createToolDeps();
		deps.manager.getRecord = vi.fn().mockReturnValue(undefined);
		const restore = vi.fn().mockRejectedValue(new Error("Child session is occupied"));
		Object.assign(deps.manager, { getSavedRecord: vi.fn(() => ({ type: "general-purpose" })), restore });
		const result = await execute(deps, { prompt: "continue", description: "resume", resume: "saved" });
		expect(result.content[0].text).toContain("Cold resume refused: Child session is occupied");
		expect(deps.manager.resume).not.toHaveBeenCalled();
	});

	it("returns not-found when resume ID does not exist", async () => {
		const deps = createToolDeps();
		deps.manager.getRecord = vi.fn().mockReturnValue(undefined);
		const result = await execute(deps, {
			prompt: "continue",
			description: "resume",
			subagent_type: "general-purpose",
			resume: "nonexistent",
		});
		expect(result.content[0].text).toContain("Agent not found");
	});

	it("returns no-session when agent has no active session", async () => {
		const deps = createToolDeps();
		// No execution state set — session not yet created
		deps.manager.getRecord = vi.fn().mockReturnValue(createTestSubagent());
		const result = await execute(deps, {
			prompt: "continue",
			description: "resume",
			subagent_type: "general-purpose",
			resume: "agent-1",
		});
		expect(result.content[0].text).toContain("no active session");
	});

	it("returns not-found copy without claiming cleanup for an unknown resume ID", async () => {
		const deps = createToolDeps();
		deps.manager.getRecord = vi.fn().mockReturnValue(undefined);
		const result = await execute(deps, {
			prompt: "continue",
			description: "resume",
			subagent_type: "general-purpose",
			resume: "nonexistent",
		});
		expect(result.content[0].text).toContain("Agent not found");
		expect(result.content[0].text).not.toContain("cleaned up");
	});

	it("points a released-agent resume at get_subagent_result instead of resuming", async () => {
		const deps = createToolDeps();
		const released = createTestSubagent();
		released.subagentSession = toSubagentSession(createSubagentSessionStub(createMockSession(), "/tasks/agent.jsonl"));
		await released.releaseSession();
		deps.manager.getRecord = vi.fn().mockReturnValue(released);
		const result = await execute(deps, {
			prompt: "continue",
			description: "resume",
			subagent_type: "general-purpose",
			resume: "agent-1",
		});
		expect(result.content[0].text).toContain("get_subagent_result");
		expect(deps.manager.resume).not.toHaveBeenCalled();
	});

	it("returns result text on successful resume", async () => {
		const deps = createToolDeps();
		const resumeRecord = createTestSubagent();
		resumeRecord.subagentSession = toSubagentSession(createSubagentSessionStub(createMockSession()));
		deps.manager.getRecord = vi.fn().mockReturnValue(resumeRecord);
		deps.manager.resume = vi.fn().mockResolvedValue(createTestSubagent({ result: "Resumed output." }));
		const result = await execute(deps, {
			prompt: "continue",
			description: "resume",
			subagent_type: "general-purpose",
			resume: "agent-1",
		});
		expect(result.content[0].text).toContain("Resumed output.");
		expect(deps.manager.resume).toHaveBeenCalledWith(
			"agent-1",
			"continue",
			{ kind: "resume", source: "tool", toolCallId: "tc-1" },
			{ maxTurns: 30, wrapUpTurns: 2, maxDurationSeconds: 1800 },
			expect.any(AbortSignal),
		);
	});

	it("marks the resumed record consumed (resume-return delivery edge)", async () => {
		const deps = createToolDeps();
		const resumeRecord = createTestSubagent();
		resumeRecord.subagentSession = toSubagentSession(createSubagentSessionStub(createMockSession()));
		deps.manager.getRecord = vi.fn().mockReturnValue(resumeRecord);
		const resumed = createTestSubagent({ result: "Resumed output." });
		deps.manager.resume = vi.fn().mockResolvedValue(resumed);
		await execute(deps, {
			prompt: "continue",
			description: "resume",
			subagent_type: "general-purpose",
			resume: "agent-1",
		});
		expect(resumed.consumed).toBe(true);
	});
});

describe("AgentTool — model resolution error", () => {
	it("returns error when model resolution fails", async () => {
		const deps = createToolDeps();
		const result = await execute(
			deps,
			{
				prompt: "test",
				description: "test",
				subagent_type: "general-purpose",
				model: "nonexistent-model-xyz",
			},
		);
		// User-specified model that doesn't resolve → error message
		expect(result.content[0].text).toContain("nonexistent-model-xyz");
	});
});

describe("AgentTool — background execution", () => {
	it("returns background launch message with agent ID", async () => {
		const deps = createToolDeps();
		const record = createTestSubagent({ phase: "running" });
		deps.manager.getRecord = vi.fn().mockReturnValue(record);
		const result = await execute(deps, {
			prompt: "do something",
			description: "bg task",
			subagent_type: "general-purpose",
			run_in_background: true,
		});
		const text = result.content[0].text;
		expect(text).toContain("background");
		expect(text).toContain("agent-1");
		expect(text).toContain("bg task");
	});

	it("does not emit subagents:created directly — delegated to observer.onSubagentCreated", async () => {
		// The subagents:created event is now emitted by SubagentManagerObserver.onSubagentCreated,
		// called from SubagentManager.spawn(). Tested in subagent-manager.test.ts.
		// This test ensures the tool no longer holds an emitEvent dep for this purpose.
		const deps = createToolDeps();
		deps.manager.getRecord = vi.fn().mockReturnValue(createTestSubagent({ phase: "running" }));
		const result = await execute(deps, {
			prompt: "do something",
			description: "bg task",
			subagent_type: "general-purpose",
			run_in_background: true,
		});
		// Background spawn succeeds — no emitEvent dep required
		expect(result.content[0].text).toContain("background");
	});

	it("passes parentSession.toolCallId to manager.spawn", async () => {
		const deps = createToolDeps();
		deps.manager.getRecord = vi.fn().mockReturnValue(createTestSubagent({ phase: "running" }));
		await execute(deps, {
			prompt: "do something",
			description: "bg task",
			subagent_type: "general-purpose",
			run_in_background: true,
		});
		const spawnOpts = (deps.manager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][3];
		expect(spawnOpts.parentSession?.toolCallId).toBe("tc-1");
	});
});

describe("AgentTool — foreground execution", () => {
	it("returns completion message with stats", async () => {
		const deps = createToolDeps();
		deps.manager.spawnAndWait = vi.fn().mockResolvedValue(
			createTestSubagent({ id: "foreground-success", result: "Task complete.", toolUses: 5 }),
		);
		const result = await execute(deps, {
			prompt: "do task",
			description: "fg task",
			subagent_type: "general-purpose",
		});
		const text = result.content[0].text;
		expect(text).toContain("Agent ID: foreground-success");
		expect(text).toContain("Agent completed");
		expect(text).toContain("Task complete.");
	});

	it("returns error message when agent fails", async () => {
		const deps = createToolDeps();
		deps.manager.spawnAndWait = vi.fn().mockResolvedValue(
			createTestSubagent({ id: "foreground-error", phase: "terminal", outcome: "error", error: "Out of context" }),
		);
		const result = await execute(deps, {
			prompt: "do task",
			description: "fg task",
			subagent_type: "general-purpose",
		});
		expect(result.content[0].text).toContain("Agent ID: foreground-error");
		expect(result.content[0].text).toContain("Agent failed");
		expect(result.content[0].text).toContain("Out of context");
	});

	it("returns error when spawnAndWait throws", async () => {
		const deps = createToolDeps();
		deps.manager.spawnAndWait = vi.fn().mockRejectedValue(new Error("spawn failure"));
		const result = await execute(deps, {
			prompt: "do task",
			description: "fg task",
			subagent_type: "general-purpose",
		});
		expect(result.content[0].text).toContain("spawn failure");
	});
});
