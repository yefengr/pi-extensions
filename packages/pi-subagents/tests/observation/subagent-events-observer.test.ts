import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildLifecycleEventData,
	buildLifecycleRecord,
} from "#src/lifecycle/lifecycle-record";
import type { NotificationSystem } from "#src/observation/notification";
import { SubagentEventsObserver } from "#src/observation/subagent-events-observer";
import type { CompactionInfo } from "#src/types";
import { createTestSubagent } from "#test/helpers/make-subagent";
import { createMockSession, createSubagentSessionStub, toSubagentSession } from "#test/helpers/mock-session";

function makeNotifications(): NotificationSystem {
	return {
		sendCompletion: vi.fn(),
		dispose: vi.fn(),
	};
}

function makeObserver(overrides?: Partial<{ notifications: NotificationSystem }>) {
	const emit = vi.fn<(channel: string, data: unknown) => void>();
	const appendEntry = vi.fn<(customType: string, data: unknown) => void>();
	const notifications = overrides?.notifications ?? makeNotifications();
	const observer = new SubagentEventsObserver({ emit, appendEntry, notifications });
	return { observer, emit, appendEntry, notifications };
}

describe("SubagentEventsObserver", () => {
	describe("non-terminal events", () => {
		it("emits lifecycle v3 for started without persisting", () => {
			vi.useFakeTimers();
			vi.setSystemTime(5000);
			try {
				const { observer, emit, appendEntry } = makeObserver();
				const record = createTestSubagent({
					id: "agent-1",
					type: "general-purpose",
					description: "do work",
					phase: "running",
					completedAt: undefined,
					sessionCreated: false,
				});

				observer.onSubagentStarted(record);

				expect(emit).toHaveBeenCalledExactlyOnceWith(
					"subagents:started",
					buildLifecycleEventData(record),
				);
				expect(appendEntry).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it("emits lifecycle v3 plus compaction details", () => {
			const { observer, emit } = makeObserver();
			const record = createTestSubagent({ compactionCount: 1 });
			const info: CompactionInfo = { reason: "threshold", tokensBefore: 50_000 };

			observer.onSubagentCompacted(record, info);

			expect(emit).toHaveBeenCalledExactlyOnceWith("subagents:compacted", {
				...buildLifecycleEventData(record),
				reason: "threshold",
				tokensBefore: 50_000,
				compactionCount: 1,
			});
		});

		it("emits lifecycle v3 for queued background creation", () => {
			vi.useFakeTimers();
			vi.setSystemTime(5000);
			try {
				const { observer, emit } = makeObserver();
				const record = createTestSubagent({
					phase: "queued",
					completedAt: undefined,
					sessionCreated: false,
				});

				observer.onSubagentCreated(record);

				expect(emit).toHaveBeenCalledExactlyOnceWith(
					"subagents:created",
					buildLifecycleEventData(record),
				);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("fresh terminal records", () => {
		it("emits and persists the same strict lifecycle-v3 object", () => {
			const { observer, emit, appendEntry } = makeObserver();
			const record = createTestSubagent({
				id: "agent-2",
				type: "Explore",
				description: "explore\n  code",
				phase: "terminal", outcome: "completed",
				result: "found it",
				toolCallId: "fresh-call-1",
				sessionId: "child-session-2",
				outputFile: "/sessions/child-2.jsonl",
				startedAt: 1000,
				completedAt: 2000,
				invocationStartedAt: 1100,
				invocationToolUses: 2,
				invocationUsage: { input: 30, output: 20, cacheWrite: 5 },
				toolUses: 7,
				lifetimeUsage: { input: 130, output: 70, cacheWrite: 15 },
			});
			const expected = buildLifecycleRecord(record);

			observer.onSubagentCompleted(record);

			expect(expected).toMatchObject({
				recordVersion: 3,
				description: "explore code",
				invocationKind: "fresh",
				invocationSource: "tool",
				toolCallId: "fresh-call-1",
				sessionState: "created",
				sessionId: "child-session-2",
				startedAt: 1100,
				completedAt: 2000,
				invocationUsage: { input: 30, output: 20, cacheWrite: 5, total: 55 },
				lifetimeUsage: { input: 130, output: 70, cacheWrite: 15, total: 215 },
			});
			expect(emit).toHaveBeenCalledExactlyOnceWith("subagents:completed", expected);
			expect(appendEntry).toHaveBeenCalledExactlyOnceWith("subagents:record", expected);
			expect(emit.mock.calls[0][1]).toBe(appendEntry.mock.calls[0][1]);
		});

		it.each(["error", "turn_limit", "timeout", "cancelled"] as const)(
			"emits subagents:failed for terminal %s",
			(outcome) => {
				const { observer, emit } = makeObserver();
				const record = createTestSubagent({
					phase: "terminal",
					outcome,
					error: outcome === "error" ? "boom" : undefined,
				});
				observer.onSubagentCompleted(record);
				expect(emit).toHaveBeenCalledWith("subagents:failed", buildLifecycleRecord(record));
			},
		);

		it("allows explicit terminal no-session states", () => {
			const { observer, appendEntry } = makeObserver();
			const record = createTestSubagent({
				phase: "terminal", outcome: "cancelled",
				stoppedWhileQueued: true,
				sessionCreated: false,
			});

			observer.onSubagentCompleted(record);

			expect(appendEntry.mock.calls[0][1]).toMatchObject({
				recordVersion: 3,
				sessionState: "not-created",
				phase: "terminal", outcome: "cancelled",
			});
			expect(appendEntry.mock.calls[0][1]).not.toHaveProperty("sessionId");
		});

		it("fails closed when a successful terminal record has no sessionId", () => {
			const { observer, emit, appendEntry } = makeObserver();
			const record = createTestSubagent({ phase: "terminal", outcome: "completed", sessionCreated: false });

			expect(() => observer.onSubagentCompleted(record)).toThrow(/cannot omit sessionId/);
			expect(emit).not.toHaveBeenCalled();
			expect(appendEntry).not.toHaveBeenCalled();
		});

		it("notifies only background completions", () => {
			const notifications = makeNotifications();
			const { observer } = makeObserver({ notifications });
			const background = createTestSubagent({ isBackground: true });
			const foreground = createTestSubagent({ id: "foreground", isBackground: false });

			observer.onSubagentCompleted(background);
			observer.onSubagentCompleted(foreground);

			expect(notifications.sendCompletion).toHaveBeenCalledExactlyOnceWith(background);
		});
	});

	describe("resume terminal records", () => {
		it("records the current resume invocation without leaking pre-resume usage", async () => {
			const { observer, emit, appendEntry } = makeObserver();
			const session = createMockSession();
			const stub = createSubagentSessionStub(session, "/sessions/resume.jsonl", "stable-session");
			stub.resumeTurnLoop.mockImplementation(async () => {
				session.emit({
					type: "message_end",
					message: {
						role: "assistant",
						usage: { input: 7, output: 3, cacheWrite: 1 },
					},
				});
				return { responseText: "resumed output", outcome: "completed", wrappedUp: false };
			});
			const record = createTestSubagent({
				isBackground: false,
				sessionId: "stable-session",
				outputFile: "/sessions/resume.jsonl",
				toolUses: 4,
				lifetimeUsage: { input: 100, output: 50, cacheWrite: 10 },
			});
			record.subagentSession = toSubagentSession(stub);
			await record.resume("continue", {
				kind: "resume",
				source: "tool",
				toolCallId: "resume-call-9",
			});
			const expected = buildLifecycleRecord(record);

			observer.onSubagentResumed(record);

			expect(expected).toMatchObject({
				sessionId: "stable-session",
				invocationKind: "resume",
				invocationIndex: 2,
				toolCallId: "resume-call-9",
				invocationUsage: { input: 7, output: 3, cacheWrite: 1, total: 11 },
				lifetimeUsage: { input: 107, output: 53, cacheWrite: 11, total: 171 },
			});
			expect(emit).toHaveBeenCalledExactlyOnceWith("subagents:resumed", expected);
			expect(appendEntry).toHaveBeenCalledExactlyOnceWith("subagents:record", expected);
		});
	});

	describe("dependency isolation", () => {
		let emit: ReturnType<typeof vi.fn>;
		let appendEntry: ReturnType<typeof vi.fn>;
		let notifications: NotificationSystem;
		let observer: SubagentEventsObserver;

		beforeEach(() => {
			({ observer, emit, appendEntry, notifications } = makeObserver());
		});

		it("runs without a Pi SDK object", () => {
			observer.onSubagentStarted(createTestSubagent());
			observer.onSubagentCompleted(createTestSubagent({ phase: "terminal", outcome: "completed" }));
			observer.onSubagentCompacted(createTestSubagent(), {
				reason: "overflow",
				tokensBefore: 9999,
			});
			observer.onSubagentCreated(createTestSubagent());
			expect(emit).toHaveBeenCalledTimes(4);
			expect(appendEntry).toHaveBeenCalledTimes(1);
			expect(notifications.sendCompletion).toHaveBeenCalledTimes(1);
		});
	});
});
