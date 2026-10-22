export class InvocationTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Subagent invocation timed out after ${Math.ceil(timeoutMs / 1000)} seconds`);
    this.name = "InvocationTimeoutError";
  }
}

export class InvocationCancelledError extends Error {
  constructor() {
    super("Subagent invocation was cancelled");
    this.name = "InvocationCancelledError";
  }
}

export interface InvocationControlOptions {
  maxDurationMs: number;
  abortGraceMs: number;
  cancelSignal: AbortSignal;
  onTimeout: () => void;
}

/**
 * Applies one wall-clock budget to a complete invocation. An in-flight timeout
 * or cancellation first aborts cooperative work, then releases the waiter after
 * the abort grace when that work does not settle.
 */
export class InvocationControl {
  private readonly timeoutController = new AbortController();
  private readonly timeoutError: InvocationTimeoutError;
  private readonly failure: Promise<never>;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private rejectFailure!: (reason: unknown) => void;
  private timedOut = false;
  private cancelled = false;
  private disposed = false;

  readonly signal: AbortSignal;

  constructor(private readonly options: InvocationControlOptions) {
    this.timeoutError = new InvocationTimeoutError(options.maxDurationMs);
    this.signal = AbortSignal.any([options.cancelSignal, this.timeoutController.signal]);
    this.failure = new Promise<never>((_resolve, reject) => {
      this.rejectFailure = reject;
    });
    void this.failure.catch(() => {});

    if (options.cancelSignal.aborted) {
      this.rejectFailure(new InvocationCancelledError());
    } else {
      options.cancelSignal.addEventListener("abort", this.handleCancel, { once: true });
    }

    this.deadlineTimer = setTimeout(this.handleDeadline, options.maxDurationMs);
    this.deadlineTimer.unref?.();
  }

  get didTimeOut(): boolean {
    return this.timedOut;
  }

  async waitFor<T>(operation: Promise<T>): Promise<T> {
    try {
      const value = await Promise.race([operation, this.failure]);
      if (this.timedOut) throw this.timeoutError;
      return value;
    } catch (error) {
      if (this.timedOut) throw this.timeoutError;
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.options.cancelSignal.removeEventListener("abort", this.handleCancel);
  }

  private readonly handleCancel = (): void => {
    if (this.disposed || this.cancelled) return;
    this.cancelled = true;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
    this.graceTimer = setTimeout(
      () => this.rejectFailure(new InvocationCancelledError()),
      this.options.abortGraceMs,
    );
    this.graceTimer.unref?.();
  };

  private readonly handleDeadline = (): void => {
    if (this.disposed || this.timedOut) return;
    this.timedOut = true;
    this.options.onTimeout();
    this.timeoutController.abort(this.timeoutError);
    this.graceTimer = setTimeout(() => this.rejectFailure(this.timeoutError), this.options.abortGraceMs);
    this.graceTimer.unref?.();
  };
}

export function isInvocationTimeout(error: unknown): error is InvocationTimeoutError {
  return error instanceof InvocationTimeoutError;
}

export function isInvocationCancelled(error: unknown): error is InvocationCancelledError {
  return error instanceof InvocationCancelledError;
}
