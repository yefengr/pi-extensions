import { afterEach, describe, expect, it, vi } from "vitest";
import { withForegroundProgress } from "#src/tools/foreground-progress";
import { createResolvedSpawnConfig } from "#test/helpers/make-spawn-config";

describe("foreground progress callback lifecycle", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("isolates a failed progress callback and clears updates while awaiting the actual result", async () => {
    vi.useFakeTimers();
    const completion = Promise.withResolvers<string>();
    const callback = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error("UI closed"); });
    const pending = withForegroundProgress(createResolvedSpawnConfig(), () => undefined, callback, () => completion.promise);
    await vi.advanceTimersByTimeAsync(80);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    completion.resolve("actual final result");
    await expect(pending).resolves.toBe("actual final result");
  });

  it("cleans the spinner when execution rejects", async () => {
    vi.useFakeTimers();
    await expect(withForegroundProgress(createResolvedSpawnConfig(), () => undefined, vi.fn(),
      async () => { throw new Error("execution failed"); })).rejects.toThrow("execution failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not schedule rendering when no update consumer exists", async () => {
    vi.useFakeTimers();
    const completion = Promise.withResolvers<void>();
    const pending = withForegroundProgress(createResolvedSpawnConfig(), () => undefined, undefined, () => completion.promise);
    expect(vi.getTimerCount()).toBe(0);
    completion.resolve();
    await pending;
  });
});
