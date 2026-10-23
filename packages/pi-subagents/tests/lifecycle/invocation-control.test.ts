import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InvocationCancelledError,
  InvocationControl,
  InvocationTimeoutError,
} from "#src/lifecycle/invocation-control";

function makeControl(overrides: Partial<ConstructorParameters<typeof InvocationControl>[0]> = {}) {
  const cancelController = new AbortController();
  const onTimeout = vi.fn();
  const control = new InvocationControl({
    maxDurationMs: 1_000,
    abortGraceMs: 200,
    cancelSignal: cancelController.signal,
    onTimeout,
    ...overrides,
  });
  return { control, cancelController, onTimeout };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("InvocationControl", () => {
  it("returns an operation that settles before the deadline", async () => {
    vi.useFakeTimers();
    const { control, onTimeout } = makeControl();

    await expect(control.waitFor(Promise.resolve("done"))).resolves.toBe("done");
    control.dispose();
    await vi.runAllTimersAsync();

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("aborts at the deadline and classifies a cooperative exit as timeout", async () => {
    vi.useFakeTimers();
    const { control, onTimeout } = makeControl();
    const operation = new Promise<void>((_resolve, reject) => {
      control.signal.addEventListener("abort", () => reject(control.signal.reason), { once: true });
    });
    const assertion = expect(control.waitFor(operation)).rejects.toBeInstanceOf(
      InvocationTimeoutError,
    );

    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(control.didTimeOut).toBe(true);
    expect(control.signal.aborted).toBe(true);
    control.dispose();
  });

  it("releases a non-cooperative waiter after the abort grace", async () => {
    vi.useFakeTimers();
    const { control } = makeControl();
    const waiting = control.waitFor(new Promise<void>(() => {}));
    const assertion = expect(waiting).rejects.toBeInstanceOf(InvocationTimeoutError);

    await vi.advanceTimersByTimeAsync(1_199);
    let settled = false;
    void waiting.finally(() => { settled = true; }).catch(() => {});
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    control.dispose();
  });

  it("releases a non-cooperative cancelled invocation after the abort grace", async () => {
    vi.useFakeTimers();
    const { control, cancelController, onTimeout } = makeControl();
    const waiting = control.waitFor(new Promise<void>(() => {}));
    const assertion = expect(waiting).rejects.toBeInstanceOf(InvocationCancelledError);
    let settled = false;
    void waiting.finally(() => { settled = true; }).catch(() => {});

    cancelController.abort();
    await vi.advanceTimersByTimeAsync(199);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(control.signal.aborted).toBe(true);
    expect(onTimeout).not.toHaveBeenCalled();
    control.dispose();
  });

  it("accepts an already-cancelled signal", async () => {
    vi.useFakeTimers();
    const cancelController = new AbortController();
    cancelController.abort();
    const { control } = makeControl({ cancelSignal: cancelController.signal });

    await expect(control.waitFor(new Promise<void>(() => {}))).rejects.toBeInstanceOf(
      InvocationCancelledError,
    );
    control.dispose();
  });
});
