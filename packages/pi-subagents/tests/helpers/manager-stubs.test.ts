import { describe, expect, it, vi } from "vitest";
import { createBlockingFactory, createSessionFactory, createSessionStub } from "./manager-stubs";
import { createMockSession } from "./mock-session";

describe("createBlockingFactory", () => {
	it("returns a pending promise (never resolves)", () => {
		const factory = createBlockingFactory();
		const p = factory({} as never);
		let settled = false;
		void p.then(() => {
			settled = true;
		});
		expect(settled).toBe(false);
	});

	it("is a vi.fn stub", () => {
		const factory = createBlockingFactory();
		expect(vi.isMockFunction(factory)).toBe(true);
	});
});

describe("createSessionStub", () => {
	it("wraps the given session", () => {
		const session = createMockSession();
		const stub = createSessionStub(session);
		expect(stub.session).toBe(session);
	});

	it("exposes the outputFile and sessionId", () => {
		const stub = createSessionStub(createMockSession(), "/tmp/out.jsonl", "child-1");
		expect(stub.outputFile).toBe("/tmp/out.jsonl");
		expect(stub.sessionId).toBe("child-1");
	});

	it("runTurnLoop resolves to a completed TurnLoopResult by default", async () => {
		const stub = createSessionStub();
		await expect(stub.runTurnLoop("go", { maxTurns: 30, wrapUpTurns: 2 })).resolves.toEqual({
			responseText: "done",
			outcome: "completed",
			wrappedUp: false,
		});
	});

	it("resumeTurnLoop resolves to a completed TurnLoopResult by default", async () => {
		const stub = createSessionStub();
		await expect(stub.resumeTurnLoop("more", { maxTurns: 30, wrapUpTurns: 2 })).resolves.toEqual({
			responseText: "resumed",
			outcome: "completed",
			wrappedUp: false,
		});
	});

	it("exposes an abort method that records the call", async () => {
		const stub = createSessionStub();
		await stub.abort();
		expect(stub.abort).toHaveBeenCalledOnce();
	});
});

describe("createSessionFactory", () => {
	it("resolves to a SubagentSession stub wrapping the given session", async () => {
		const session = createMockSession();
		const { factory, stub } = createSessionFactory(session);
		const sub = await factory({} as never);
		expect(sub).toBe(stub);
		expect(stub.session).toBe(session);
	});

	it("exposes the outputFile on the stub", async () => {
		const { stub } = createSessionFactory(createMockSession(), "/tmp/out.jsonl");
		expect(stub.outputFile).toBe("/tmp/out.jsonl");
	});

	it("runTurnLoop resolves to a completed TurnLoopResult by default", async () => {
		const { stub } = createSessionFactory();
		await expect(stub.runTurnLoop("go", { maxTurns: 30, wrapUpTurns: 2 })).resolves.toEqual({
			responseText: "done",
			outcome: "completed",
			wrappedUp: false,
		});
	});

	it("the stub exposes abort", async () => {
		const { stub } = createSessionFactory();
		await stub.abort();
		expect(stub.abort).toHaveBeenCalledOnce();
	});

	it("the factory is a vi.fn stub", () => {
		const { factory } = createSessionFactory();
		expect(vi.isMockFunction(factory)).toBe(true);
	});
});
