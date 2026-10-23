import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubagentsSettingsHandler } from "#src/ui/subagents-settings";
import { makeMenuUI } from "#test/helpers/ui-stubs";

function makeSettings() {
  return {
    maxConcurrent: 4,
    maxTurns: 30,
    wrapUpTurns: 2,
    maxDurationSeconds: 1800,
    maxQueueWaitSeconds: 900,
    abortGraceSeconds: 5,
    applyMaxConcurrent: vi.fn((): { message: string; level: "info" | "warning" } => ({
      message: "Max concurrency set to 8",
      level: "info",
    })),
    applyMaxTurns: vi.fn((): { message: string; level: "info" | "warning" } => ({
      message: "Max turns set to 20",
      level: "info",
    })),
    applyWrapUpTurns: vi.fn((): { message: string; level: "info" | "warning" } => ({
      message: "Wrap-up turns set to 3",
      level: "info",
    })),
    applyMaxDurationSeconds: vi.fn((): { message: string; level: "info" | "warning" } => ({
      message: "Max duration set to 3600 s",
      level: "info",
    })),
    applyMaxQueueWaitSeconds: vi.fn((): { message: string; level: "info" | "warning" } => ({
      message: "Max queue wait set to 600 s",
      level: "info",
    })),
    applyAbortGraceSeconds: vi.fn((): { message: string; level: "info" | "warning" } => ({
      message: "Abort grace set to 10 s",
      level: "info",
    })),
    consumedSessionRetentionMinutes: 10,
    unconsumedSessionRetentionMinutes: 720,
    applyConsumedSessionRetentionMinutes: vi.fn((): { message: string; level: "info" | "warning" } => ({
      message: "Consumed-session retention set to 30 min",
      level: "info",
    })),
    applyUnconsumedSessionRetentionMinutes: vi.fn((): { message: string; level: "info" | "warning" } => ({
      message: "Unconsumed-session retention set to 1440 min",
      level: "info",
    })),
    abortAllOnInterrupt: true,
    toggleAbortAllOnInterrupt: vi.fn((): { message: string; level: "info" | "warning" } => ({
      message: "Abort all subagents on ESC: off",
      level: "info",
    })),
  };
}

function makeHandler(settings = makeSettings()) {
  const handler = new SubagentsSettingsHandler(settings);
  return { handler, settings };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("SubagentsSettingsHandler", () => {
  it("is constructable", () => {
    const { handler } = makeHandler();
    expect(handler).toBeInstanceOf(SubagentsSettingsHandler);
  });

  it("shows the nine settings options with current values", async () => {
    const { handler } = makeHandler();
    const ui = makeMenuUI([undefined]); // cancel immediately
    await handler.handle({ ui });
    const options = ui.select.mock.calls[0][1] as string[];
    expect(options).toEqual([
      "Max concurrency (current: 4)",
      "Max turns (current: 30)",
      "Wrap-up turns (current: 2)",
      "Max duration (current: 1800 s)",
      "Max queue wait (current: 900 s)",
      "Abort grace (current: 5 s)",
      "Consumed-session retention (current: 10 min)",
      "Unconsumed-session retention (current: 720 min)",
      "Abort all subagents on ESC (current: on)",
    ]);
  });

  it("renders the abort-on-ESC option as off when the policy is disabled", async () => {
    const settings = makeSettings();
    settings.abortAllOnInterrupt = false;
    const { handler } = makeHandler(settings);
    const ui = makeMenuUI([undefined]);
    await handler.handle({ ui });
    const options = ui.select.mock.calls[0][1] as string[];
    expect(options[8]).toBe("Abort all subagents on ESC (current: off)");
  });

  it("applies no change when the settings list is cancelled", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI([undefined]);
    await handler.handle({ ui });
    expect(settings.applyMaxConcurrent).not.toHaveBeenCalled();
    expect(settings.applyMaxTurns).not.toHaveBeenCalled();
    expect(settings.applyWrapUpTurns).not.toHaveBeenCalled();
    expect(settings.applyMaxDurationSeconds).not.toHaveBeenCalled();
    expect(ui.input).not.toHaveBeenCalled();
  });
});

describe("SubagentsSettingsHandler — max concurrency", () => {
  it("delegates a valid value to applyMaxConcurrent and notifies the returned toast", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Max concurrency (current: 4)"]);
    ui.input = vi.fn().mockResolvedValue("8");
    await handler.handle({ ui });
    expect(settings.applyMaxConcurrent).toHaveBeenCalledWith(8);
    expect(ui.notify).toHaveBeenCalledWith("Max concurrency set to 8", "info");
  });

  it("rejects a value below 1 with a warning and does not apply", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Max concurrency (current: 4)"]);
    ui.input = vi.fn().mockResolvedValue("0");
    await handler.handle({ ui });
    expect(settings.applyMaxConcurrent).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Must be a positive integer.", "warning");
  });

  it("does not apply when the input is cancelled", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Max concurrency (current: 4)"]);
    ui.input = vi.fn().mockResolvedValue(undefined);
    await handler.handle({ ui });
    expect(settings.applyMaxConcurrent).not.toHaveBeenCalled();
  });

  it("rejects non-numeric input with a warning and does not apply", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Max concurrency (current: 4)"]);
    ui.input = vi.fn().mockResolvedValue("abc");
    await handler.handle({ ui });
    expect(settings.applyMaxConcurrent).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Must be a positive integer.", "warning");
  });
});

describe("SubagentsSettingsHandler — max turns", () => {
  it("delegates a positive value to applyMaxTurns and notifies the returned toast", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Max turns (current: 30)"]);
    ui.input = vi.fn().mockResolvedValue("20");
    await handler.handle({ ui });
    expect(settings.applyMaxTurns).toHaveBeenCalledWith(20);
    expect(ui.notify).toHaveBeenCalledWith("Max turns set to 20", "info");
  });

  it("rejects 0 with a warning — 0 is not unlimited any more", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Max turns (current: 30)"]);
    ui.input = vi.fn().mockResolvedValue("0");
    await handler.handle({ ui });
    expect(settings.applyMaxTurns).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Must be a positive integer.", "warning");
  });
});

describe("SubagentsSettingsHandler — wrap-up turns", () => {
  it("delegates a positive value to applyWrapUpTurns and notifies the returned toast", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Wrap-up turns (current: 2)"]);
    ui.input = vi.fn().mockResolvedValue("3");
    await handler.handle({ ui });
    expect(settings.applyWrapUpTurns).toHaveBeenCalledWith(3);
    expect(ui.notify).toHaveBeenCalledWith("Wrap-up turns set to 3", "info");
  });

  it("accepts 0 (stop at the hard limit)", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Wrap-up turns (current: 2)"]);
    ui.input = vi.fn().mockResolvedValue("0");
    await handler.handle({ ui });
    expect(settings.applyWrapUpTurns).toHaveBeenCalledWith(0);
  });

  it("rejects a negative value with a warning and does not apply", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Wrap-up turns (current: 2)"]);
    ui.input = vi.fn().mockResolvedValue("-1");
    await handler.handle({ ui });
    expect(settings.applyWrapUpTurns).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Must be 0 or a positive integer.", "warning");
  });
});

describe("SubagentsSettingsHandler — duration budgets in seconds", () => {
  it("delegates a valid max duration to applyMaxDurationSeconds", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Max duration (current: 1800 s)"]);
    ui.input = vi.fn().mockResolvedValue("3600");
    await handler.handle({ ui });
    expect(settings.applyMaxDurationSeconds).toHaveBeenCalledWith(3600);
    expect(ui.notify).toHaveBeenCalledWith("Max duration set to 3600 s", "info");
  });

  it("rejects a max duration below 1 with a warning", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Max duration (current: 1800 s)"]);
    ui.input = vi.fn().mockResolvedValue("0");
    await handler.handle({ ui });
    expect(settings.applyMaxDurationSeconds).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Must be a positive integer.", "warning");
  });

  it("delegates a valid queue wait to applyMaxQueueWaitSeconds", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Max queue wait (current: 900 s)"]);
    ui.input = vi.fn().mockResolvedValue("600");
    await handler.handle({ ui });
    expect(settings.applyMaxQueueWaitSeconds).toHaveBeenCalledWith(600);
    expect(ui.notify).toHaveBeenCalledWith("Max queue wait set to 600 s", "info");
  });

  it("delegates a valid abort grace to applyAbortGraceSeconds", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Abort grace (current: 5 s)"]);
    ui.input = vi.fn().mockResolvedValue("10");
    await handler.handle({ ui });
    expect(settings.applyAbortGraceSeconds).toHaveBeenCalledWith(10);
    expect(ui.notify).toHaveBeenCalledWith("Abort grace set to 10 s", "info");
  });

  it("rejects an abort grace below 1 with a warning", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Abort grace (current: 5 s)"]);
    ui.input = vi.fn().mockResolvedValue("0");
    await handler.handle({ ui });
    expect(settings.applyAbortGraceSeconds).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Must be a positive integer.", "warning");
  });
});

describe("SubagentsSettingsHandler — retention windows", () => {
  it("delegates a valid consumed window to applyConsumedSessionRetentionMinutes", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Consumed-session retention (current: 10 min)"]);
    ui.input = vi.fn().mockResolvedValue("30");
    await handler.handle({ ui });
    expect(settings.applyConsumedSessionRetentionMinutes).toHaveBeenCalledWith(30);
    expect(ui.notify).toHaveBeenCalledWith("Consumed-session retention set to 30 min", "info");
  });

  it("delegates a valid unconsumed window to applyUnconsumedSessionRetentionMinutes", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Unconsumed-session retention (current: 720 min)"]);
    ui.input = vi.fn().mockResolvedValue("1440");
    await handler.handle({ ui });
    expect(settings.applyUnconsumedSessionRetentionMinutes).toHaveBeenCalledWith(1440);
    expect(ui.notify).toHaveBeenCalledWith("Unconsumed-session retention set to 1440 min", "info");
  });

  it("rejects a consumed window below 1 with a warning and does not apply", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Consumed-session retention (current: 10 min)"]);
    ui.input = vi.fn().mockResolvedValue("0");
    await handler.handle({ ui });
    expect(settings.applyConsumedSessionRetentionMinutes).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Must be a positive integer.", "warning");
  });
});

describe("SubagentsSettingsHandler — abort all subagents on ESC", () => {
  it("flips the policy directly and notifies the returned toast", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Abort all subagents on ESC (current: on)"]);
    await handler.handle({ ui });
    expect(settings.toggleAbortAllOnInterrupt).toHaveBeenCalledOnce();
    expect(ui.notify).toHaveBeenCalledWith("Abort all subagents on ESC: off", "info");
  });

  it("never prompts for input — the toggle is a direct flip", async () => {
    const { handler } = makeHandler();
    const ui = makeMenuUI(["Abort all subagents on ESC (current: on)"]);
    await handler.handle({ ui });
    expect(ui.input).not.toHaveBeenCalled();
  });

  it("does not flip the policy when the settings list is cancelled", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI([undefined]);
    await handler.handle({ ui });
    expect(settings.toggleAbortAllOnInterrupt).not.toHaveBeenCalled();
  });

  it("does not flip the policy when a numeric setting is chosen", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Wrap-up turns (current: 2)"]);
    ui.input = vi.fn().mockResolvedValue("3");
    await handler.handle({ ui });
    expect(settings.toggleAbortAllOnInterrupt).not.toHaveBeenCalled();
  });
});
