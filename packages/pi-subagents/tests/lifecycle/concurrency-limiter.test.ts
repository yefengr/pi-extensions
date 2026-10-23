import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";

/** A controllable task: a thunk plus its resolve handle, for gating completion. */
function makeTask() {
	const { promise, resolve } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
	const task = vi.fn(() => promise);
	return { task, resolve };
}

describe("ConcurrencyLimiter", () => {
	describe("slot gating", () => {
		it("runs a task immediately when a slot is free", () => {
			const limiter = new ConcurrencyLimiter(() => 2);
			const { task } = makeTask();
			void limiter.schedule(task);
			expect(task).toHaveBeenCalledOnce();
		});

		it("runs tasks up to the limit and holds the rest pending", () => {
			const limiter = new ConcurrencyLimiter(() => 2);
			const a = makeTask();
			const b = makeTask();
			const c = makeTask();

			void limiter.schedule(a.task);
			void limiter.schedule(b.task);
			void limiter.schedule(c.task);

			expect(a.task).toHaveBeenCalledOnce();
			expect(b.task).toHaveBeenCalledOnce();
			expect(c.task).not.toHaveBeenCalled();
		});

		it("starts the next pending task when an active task settles", async () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const a = makeTask();
			const c = makeTask();

			void limiter.schedule(a.task);
			void limiter.schedule(c.task);

			expect(a.task).toHaveBeenCalledOnce();
			expect(c.task).not.toHaveBeenCalled();

			a.resolve();
			await Promise.resolve();
			await Promise.resolve();

			expect(c.task).toHaveBeenCalledOnce();
		});
	});

	describe("FIFO order", () => {
		it("starts pending tasks in scheduling order", async () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const order: string[] = [];
			const gates = [makeTask(), makeTask(), makeTask()] as const;
			const labels = ["first", "second", "third"];

			gates.forEach((gate, i) => {
				gate.task.mockImplementation(() => {
					order.push(labels[i]);
					const { promise, resolve } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
					gate.resolve = resolve;
					return promise;
				});
				void limiter.schedule(gate.task);
			});

			expect(order).toEqual(["first"]);

			gates[0].resolve();
			await Promise.resolve();
			await Promise.resolve();
			expect(order).toEqual(["first", "second"]);

			gates[1].resolve();
			await Promise.resolve();
			await Promise.resolve();
			expect(order).toEqual(["first", "second", "third"]);
		});
	});

	describe("schedule() promise settlement", () => {
		it("resolves the returned promise when the task resolves", async () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const { task, resolve } = makeTask();
			const scheduled = limiter.schedule(task);
			resolve();
			await expect(scheduled).resolves.toBeUndefined();
		});

		it("rejects the returned promise when the task rejects", async () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const { promise, reject } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
			const scheduled = limiter.schedule(() => promise);
			reject(new Error("boom"));
			await expect(scheduled).rejects.toThrow("boom");
		});

		it("frees the slot for the next task when a task rejects", async () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const { promise, reject } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
			const next = makeTask();

			const scheduled = limiter.schedule(() => promise);
			void limiter.schedule(next.task);
			expect(next.task).not.toHaveBeenCalled();

			reject(new Error("boom"));
			await scheduled.catch(() => {});
			await Promise.resolve();

			expect(next.task).toHaveBeenCalledOnce();
		});
	});

	describe("recheck()", () => {
		it("starts newly-admissible pending tasks when the limit grows", () => {
			let limit = 1;
			const limiter = new ConcurrencyLimiter(() => limit);
			const a = makeTask();
			const b = makeTask();

			void limiter.schedule(a.task);
			void limiter.schedule(b.task);
			expect(b.task).not.toHaveBeenCalled();

			limit = 2;
			limiter.recheck();
			expect(b.task).toHaveBeenCalledOnce();
		});

		it("does nothing when no slot is free", () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const a = makeTask();
			const b = makeTask();
			void limiter.schedule(a.task);
			void limiter.schedule(b.task);

			limiter.recheck();
			expect(b.task).not.toHaveBeenCalled();
		});

		it("re-evaluates the limit dynamically per call", () => {
			let limit = 2;
			const limiter = new ConcurrencyLimiter(() => limit);
			const a = makeTask();
			const b = makeTask();
			const c = makeTask();
			void limiter.schedule(a.task);
			void limiter.schedule(b.task);
			void limiter.schedule(c.task);
			expect(c.task).not.toHaveBeenCalled();

			// Lowering the limit below the active count starts nothing.
			limit = 1;
			limiter.recheck();
			expect(c.task).not.toHaveBeenCalled();
		});
	});

	describe("clear()", () => {
		it("drops pending tasks without running them", () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const a = makeTask();
			const pending = makeTask();
			void limiter.schedule(a.task);
			void limiter.schedule(pending.task);

			limiter.clear();
			a.resolve();

			expect(pending.task).not.toHaveBeenCalled();
		});

		it("resolves the promises of dropped pending tasks", async () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const a = makeTask();
			a.task.mockImplementation(() => new Promise<void>(() => {})); // never settles
			void limiter.schedule(a.task);
			const droppedPromise = limiter.schedule(makeTask().task);

			limiter.clear();

			await expect(droppedPromise).resolves.toBeUndefined();
		});

		it("does not disturb already-running tasks", async () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const a = makeTask();
			const scheduled = limiter.schedule(a.task);

			limiter.clear();
			a.resolve();

			await expect(scheduled).resolves.toBeUndefined();
		});
	});

	describe("schedule() timeout", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("drops a pending task at its timeout without starting it", async () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const running = makeTask();
			const queued = makeTask();
			const onTimeout = vi.fn();

			void limiter.schedule(running.task);
			const scheduled = limiter.schedule(queued.task, { timeoutMs: 1_000, onTimeout });
			expect(vi.getTimerCount()).toBe(1);

			await vi.advanceTimersByTimeAsync(999);
			expect(onTimeout).not.toHaveBeenCalled();
			expect(queued.task).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(1);
			await expect(scheduled).resolves.toBeUndefined();
			expect(onTimeout).toHaveBeenCalledOnce();
			expect(queued.task).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);

			// Freeing the slot later must not resurrect the dropped task.
			running.resolve();
			await Promise.resolve();
			await Promise.resolve();
			expect(queued.task).not.toHaveBeenCalled();

			// The consumed timer must not fire onTimeout a second time.
			await vi.advanceTimersByTimeAsync(5_000);
			expect(onTimeout).toHaveBeenCalledOnce();
		});

		it("cancels the queued timer when the task starts, so it never times out", async () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const running = makeTask();
			const queued = makeTask();
			const onTimeout = vi.fn();

			void limiter.schedule(running.task);
			void limiter.schedule(queued.task, { timeoutMs: 1_000, onTimeout });

			running.resolve();
			await Promise.resolve();
			await Promise.resolve();
			expect(queued.task).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);

			await vi.advanceTimersByTimeAsync(1_000);
			expect(onTimeout).not.toHaveBeenCalled();

			queued.resolve();
			await Promise.resolve();
			await Promise.resolve();
		});

		it("does not keep a timer for a task that starts immediately", async () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const onTimeout = vi.fn();
			const { task, resolve } = makeTask();

			const scheduled = limiter.schedule(task, { timeoutMs: 1_000, onTimeout });
			expect(task).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);

			await vi.advanceTimersByTimeAsync(5_000);
			expect(onTimeout).not.toHaveBeenCalled();

			resolve();
			await expect(scheduled).resolves.toBeUndefined();
		});

		it("times out queued entries independently and keeps survivors FIFO", async () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const running = makeTask();
			const short = makeTask();
			const long = makeTask();
			const shortTimeout = vi.fn();
			const longTimeout = vi.fn();

			void limiter.schedule(running.task);
			const shortScheduled = limiter.schedule(short.task, { timeoutMs: 100, onTimeout: shortTimeout });
			void limiter.schedule(long.task, { timeoutMs: 10_000, onTimeout: longTimeout });

			await vi.advanceTimersByTimeAsync(100);
			await expect(shortScheduled).resolves.toBeUndefined();
			expect(shortTimeout).toHaveBeenCalledOnce();
			expect(short.task).not.toHaveBeenCalled();
			expect(long.task).not.toHaveBeenCalled();

			running.resolve();
			await Promise.resolve();
			await Promise.resolve();
			expect(long.task).toHaveBeenCalledOnce();
			expect(longTimeout).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(10_000);
			expect(longTimeout).not.toHaveBeenCalled();

			long.resolve();
			await Promise.resolve();
			await Promise.resolve();
			expect(vi.getTimerCount()).toBe(0);
		});

		it("clear() cancels pending timers and never calls onTimeout", async () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const onTimeout = vi.fn();

			void limiter.schedule(makeTask().task);
			const dropped = limiter.schedule(makeTask().task, { timeoutMs: 1_000, onTimeout });
			expect(vi.getTimerCount()).toBe(1);

			limiter.clear();
			await expect(dropped).resolves.toBeUndefined();
			expect(onTimeout).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);

			await vi.advanceTimersByTimeAsync(5_000);
			expect(onTimeout).not.toHaveBeenCalled();
		});

		it("rejects the schedule promise but stays usable when onTimeout throws", async () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const running = makeTask();
			const queued = makeTask();
			const onTimeout = vi.fn(() => {
				throw new Error("boom");
			});

			void limiter.schedule(running.task);
			const scheduled = limiter.schedule(queued.task, { timeoutMs: 1_000, onTimeout });
			const rejection = expect(scheduled).rejects.toThrow("boom");

			await vi.advanceTimersByTimeAsync(1_000);
			await rejection;
			expect(onTimeout).toHaveBeenCalledOnce();
			expect(queued.task).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);

			// The queue was cleaned before onTimeout ran: the running task still
			// owns the slot, and the next FIFO entry starts when it settles.
			const next = makeTask();
			const nextScheduled = limiter.schedule(next.task);
			expect(next.task).not.toHaveBeenCalled();

			running.resolve();
			await Promise.resolve();
			await Promise.resolve();
			expect(next.task).toHaveBeenCalledOnce();

			next.resolve();
			await expect(nextScheduled).resolves.toBeUndefined();
		});
	});

	describe("schedule() without a timeout", () => {
		it("keeps plain FIFO when options carry no timeoutMs", () => {
			const limiter = new ConcurrencyLimiter(() => 1);
			const a = makeTask();
			const b = makeTask();
			const onTimeout = vi.fn();

			void limiter.schedule(a.task, {});
			void limiter.schedule(b.task, { onTimeout });

			expect(a.task).toHaveBeenCalledOnce();
			expect(b.task).not.toHaveBeenCalled();
			expect(onTimeout).not.toHaveBeenCalled();
		});

		it("rejects non-positive timeoutMs without touching the queue", () => {
			const limiter = new ConcurrencyLimiter(() => 1);

			expect(() => limiter.schedule(() => Promise.resolve(), { timeoutMs: 0 })).toThrow(RangeError);
			expect(() => limiter.schedule(() => Promise.resolve(), { timeoutMs: -5 })).toThrow(RangeError);
			expect(() => limiter.schedule(() => Promise.resolve(), { timeoutMs: Number.NaN })).toThrow(RangeError);

			// The failed schedule consumed no slot.
			const next = makeTask();
			void limiter.schedule(next.task);
			expect(next.task).toHaveBeenCalledOnce();
		});
	});

	describe("schedule() timer unref", () => {
		it("unrefs the queued-timeout timer so it cannot hold the process open", () => {
			const realSetTimeout = globalThis.setTimeout;
			let captured: ReturnType<typeof setTimeout> | undefined;
			const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
				handler: (...args: unknown[]) => void,
				ms?: number,
				...args: unknown[]
			) => {
				captured = realSetTimeout(handler, ms, ...args);
				return captured;
			}) as typeof globalThis.setTimeout);

			try {
				const limiter = new ConcurrencyLimiter(() => 1);
				void limiter.schedule(makeTask().task);
				void limiter.schedule(makeTask().task, { timeoutMs: 60_000 });

				expect(captured?.hasRef()).toBe(false);

				limiter.clear();
			} finally {
				setTimeoutSpy.mockRestore();
			}
		});
	});
});
