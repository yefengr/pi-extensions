import { describe, expect, it, vi } from "vitest";
import type { BackgroundManagerDeps } from "#src/tools/background-spawner";
import type { ForegroundManagerDeps } from "#src/tools/foreground-runner";
import { createToolDeps } from "./make-deps";
import { STUB_SNAPSHOT } from "./stub-ctx";

describe("createToolDeps", () => {
	describe("manager defaults", () => {
		it("spawn returns 'agent-1'", () => {
			const { manager } = createToolDeps();
			expect(manager.spawn(STUB_SNAPSHOT, "general-purpose", "prompt", { description: "test" })).toBe("agent-1");
		});

		it("spawnAndWait resolves to a completed record", async () => {
			const { manager } = createToolDeps();
			const record = await manager.spawnAndWait(STUB_SNAPSHOT, "general-purpose", "prompt", { description: "test" });
			expect(record.outcome).toBe("completed");
		});

		it("resume resolves to a completed record", async () => {
			const { manager } = createToolDeps();
			const record = await manager.resume(
				"id-1",
				"prompt",
				{ kind: "resume", source: "tool", toolCallId: "resume-call-1" },
				undefined,
				new AbortController().signal,
			);
			expect(record?.outcome).toBe("completed");
		});

		it("getRecord returns a completed record", () => {
			const { manager } = createToolDeps();
			const record = manager.getRecord("id-1");
			expect(record?.outcome).toBe("completed");
		});
	});

	describe("other fields", () => {
		it("agentDir is a non-empty string", () => {
			expect(createToolDeps().agentDir).toBeTypeOf("string");
		});

		it("settings defaults to the global budgets", () => {
			const { settings } = createToolDeps();
			expect(settings.maxTurns).toBe(30);
			expect(settings.wrapUpTurns).toBe(2);
			expect(settings.maxDurationSeconds).toBe(1800);
			expect(settings.maxQueueWaitSeconds).toBe(900);
			expect(settings.abortGraceSeconds).toBe(5);
			expect(settings.maxConcurrent).toBe(4);
		});

		it("registry accepts agent type lookups without throwing", () => {
			const { registry } = createToolDeps();
			expect(() => registry.resolveAgentConfig("general-purpose")).not.toThrow();
		});
	});

	describe("override merging", () => {
		it("replaces a top-level field when overridden", () => {
			const deps = createToolDeps({ agentDir: "/custom/dir" });
			expect(deps.agentDir).toBe("/custom/dir");
		});

		it("replaces the manager when overridden", () => {
			const customSpawn = vi.fn().mockReturnValue("custom-id");
			const deps = createToolDeps({
				manager: { ...createToolDeps().manager, spawn: customSpawn },
			});
			deps.manager.spawn(STUB_SNAPSHOT, "t", "p", { description: "test" });
			expect(customSpawn).toHaveBeenCalledOnce();
		});

		it("replaces settings when overridden", () => {
			const deps = createToolDeps({
				settings: {
					maxTurns: 10,
					wrapUpTurns: 1,
					maxDurationSeconds: 60,
					maxQueueWaitSeconds: 30,
					abortGraceSeconds: 3,
					maxConcurrent: 2,
				},
			});
			expect(deps.settings.maxTurns).toBe(10);
			expect(deps.settings.maxConcurrent).toBe(2);
		});
	});

	describe("structural compatibility", () => {
		it("manager satisfies BackgroundManagerDeps structurally", () => {
			const { manager } = createToolDeps();
			const bgManager: BackgroundManagerDeps = manager;
			expect(bgManager.spawn).toBeTypeOf("function");
			expect(bgManager.getRecord).toBeTypeOf("function");
		});

		it("manager satisfies ForegroundManagerDeps structurally", () => {
			const { manager } = createToolDeps();
			const fgManager: ForegroundManagerDeps = manager;
			expect(fgManager.spawnAndWait).toBeTypeOf("function");
		});
	});
});
