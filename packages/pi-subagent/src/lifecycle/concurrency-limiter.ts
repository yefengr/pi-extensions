/**
 * concurrency-limiter.ts — FIFO admission gate for background work.
 *
 * Schedules run closures (thunks) against a dynamic limit, running them in
 * scheduling order as slots free. The limiter knows nothing about agents, IDs,
 * or the manager — it owns only the active count and the pending queue.
 *
 * Every scheduled promise settles: it follows the task's settlement when the
 * task runs, resolves early if clear() drops it before it starts, or settles
 * when its queued-timeout elapses first (resolving, or rejecting if onTimeout
 * throws).
 */

/** Optional per-task bounds for schedule(). */
export interface ScheduleOptions {
	/** Positive milliseconds the task may sit queued before it is dropped. */
	timeoutMs?: number;
	/** Called once when the queued-timeout drops the task; never called by clear(). */
	onTimeout?: () => void;
}

interface PendingEntry {
	/** Start the task: consumes the entry and cancels its queued-timeout timer. */
	start: () => void;
	/** Resolve the schedule() promise without running the task. */
	settle: () => void;
	/** Cancel the queued-timeout timer if it is still armed. */
	cancelTimer: () => void;
	/** Timer armed while the entry waits in the queue. */
	timeout: ReturnType<typeof setTimeout> | undefined;
	/** Set once the entry starts or times out, so neither happens twice. */
	started: boolean;
}

export class ConcurrencyLimiter {
	private active = 0;
	private readonly pending: PendingEntry[] = [];

	constructor(private readonly getLimit: () => number) {}

	/**
	 * Schedule a task to run FIFO once a slot is free.
	 * Returns a promise that settles with the task, resolves early if the task
	 * is dropped by clear(), or settles early when options.timeoutMs elapses
	 * while the task is still pending. An already-started task ignores its
	 * timeout.
	 */
	schedule(task: () => Promise<void>, options?: ScheduleOptions): Promise<void> {
		const timeoutMs = options?.timeoutMs;
		if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
			throw new RangeError(`timeoutMs must be a positive finite number, got ${timeoutMs}`);
		}
		const onTimeout = options?.onTimeout;

		const { promise, resolve, reject } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
		const entry: PendingEntry = {
			timeout: undefined,
			started: false,
			settle: resolve,
			cancelTimer: () => {
				if (entry.timeout !== undefined) {
					clearTimeout(entry.timeout);
					entry.timeout = undefined;
				}
			},
			start: () => {
				entry.started = true;
				entry.cancelTimer();
				this.active++;
				task()
					.then(resolve, reject)
					.finally(() => {
						this.active--;
						this.recheck();
					});
			},
		};

		if (timeoutMs !== undefined) {
			const timer = setTimeout(() => {
				entry.timeout = undefined;
				// start() already consumed the entry and cleared us.
				if (entry.started) return;
				entry.started = true;
				// clear() already dropped the entry; a late timer must settle nothing.
				const index = this.pending.indexOf(entry);
				if (index === -1) return;
				this.pending.splice(index, 1);
				try {
					onTimeout?.();
				} catch (error) {
					reject(error);
					return;
				}
				resolve();
			}, timeoutMs);
			timer.unref?.();
			entry.timeout = timer;
		}

		this.pending.push(entry);
		this.recheck();
		return promise;
	}

	/** Start pending tasks until the limit is reached. Call when the limit may have grown. */
	recheck(): void {
		while (this.active < this.getLimit()) {
			const next = this.pending.shift();
			if (!next) break;
			next.start();
		}
	}

	/** Drop all pending tasks, resolving their promises without running them or firing their timeouts. */
	clear(): void {
		const dropped = this.pending.splice(0);
		for (const entry of dropped) {
			entry.cancelTimer();
			entry.settle();
		}
	}
}
