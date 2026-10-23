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

  it("states the immediate-effect save model in the list title", async () => {
    const { handler } = makeHandler();
    const ui = makeMenuUI([undefined]);
    await handler.handle({ ui });
    expect(ui.select.mock.calls[0][0]).toBe("子代理设置（修改立即生效）");
  });

  it("shows the nine settings options in Chinese with current values", async () => {
    const { handler } = makeHandler();
    const ui = makeMenuUI([undefined]); // cancel immediately
    await handler.handle({ ui });
    const options = ui.select.mock.calls[0][1] as string[];
    expect(options).toEqual([
      "最大并发数（当前：4）",
      "最大轮次（当前：30）",
      "收尾轮次（当前：2）",
      "最长运行时长（当前：1800 秒）",
      "最长排队等待（当前：900 秒）",
      "中止宽限期（当前：5 秒）",
      "已消费会话保留（当前：10 分钟）",
      "未消费会话保留（当前：720 分钟）",
      "ESC 中止全部子代理（当前：开）",
    ]);
  });

  it("renders the abort-on-ESC option as off when the policy is disabled", async () => {
    const settings = makeSettings();
    settings.abortAllOnInterrupt = false;
    const { handler } = makeHandler(settings);
    const ui = makeMenuUI([undefined]);
    await handler.handle({ ui });
    const options = ui.select.mock.calls[0][1] as string[];
    expect(options[8]).toBe("ESC 中止全部子代理（当前：关）");
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
    const ui = makeMenuUI(["最大并发数（当前：4）"]);
    ui.input = vi.fn().mockResolvedValue("8");
    await handler.handle({ ui });
    expect(settings.applyMaxConcurrent).toHaveBeenCalledWith(8);
    expect(ui.notify).toHaveBeenCalledWith("Max concurrency set to 8", "info");
  });

  it("prompts in Chinese with the current value prefilled", async () => {
    const { handler } = makeHandler();
    const ui = makeMenuUI(["最大并发数（当前：4）"]);
    ui.input = vi.fn().mockResolvedValue(undefined);
    await handler.handle({ ui });
    expect(ui.input).toHaveBeenCalledWith("最大并发数（同时运行的后台子代理上限）", "4");
  });

  it("rejects a value below 1 with a warning and does not apply", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["最大并发数（当前：4）"]);
    ui.input = vi.fn().mockResolvedValue("0");
    await handler.handle({ ui });
    expect(settings.applyMaxConcurrent).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("请输入正整数。", "warning");
  });

  it("does not apply when the input is cancelled", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["最大并发数（当前：4）"]);
    ui.input = vi.fn().mockResolvedValue(undefined);
    await handler.handle({ ui });
    expect(settings.applyMaxConcurrent).not.toHaveBeenCalled();
  });

  it("rejects non-numeric input with a warning and does not apply", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["最大并发数（当前：4）"]);
    ui.input = vi.fn().mockResolvedValue("abc");
    await handler.handle({ ui });
    expect(settings.applyMaxConcurrent).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("请输入正整数。", "warning");
  });
});

describe("SubagentsSettingsHandler — max turns", () => {
  it("delegates a positive value to applyMaxTurns and notifies the returned toast", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["最大轮次（当前：30）"]);
    ui.input = vi.fn().mockResolvedValue("20");
    await handler.handle({ ui });
    expect(settings.applyMaxTurns).toHaveBeenCalledWith(20);
    expect(ui.notify).toHaveBeenCalledWith("Max turns set to 20", "info");
  });

  it("rejects 0 with a warning — 0 is not unlimited any more", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["最大轮次（当前：30）"]);
    ui.input = vi.fn().mockResolvedValue("0");
    await handler.handle({ ui });
    expect(settings.applyMaxTurns).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("请输入正整数。", "warning");
  });
});

describe("SubagentsSettingsHandler — wrap-up turns", () => {
  it("delegates a positive value to applyWrapUpTurns and notifies the returned toast", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["收尾轮次（当前：2）"]);
    ui.input = vi.fn().mockResolvedValue("3");
    await handler.handle({ ui });
    expect(settings.applyWrapUpTurns).toHaveBeenCalledWith(3);
    expect(ui.notify).toHaveBeenCalledWith("Wrap-up turns set to 3", "info");
  });

  it("accepts 0 (stop at the hard limit)", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["收尾轮次（当前：2）"]);
    ui.input = vi.fn().mockResolvedValue("0");
    await handler.handle({ ui });
    expect(settings.applyWrapUpTurns).toHaveBeenCalledWith(0);
  });

  it("rejects a negative value with a warning and does not apply", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["收尾轮次（当前：2）"]);
    ui.input = vi.fn().mockResolvedValue("-1");
    await handler.handle({ ui });
    expect(settings.applyWrapUpTurns).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("请输入 0 或正整数。", "warning");
  });
});

describe("SubagentsSettingsHandler — duration budgets in seconds", () => {
  it("delegates a valid max duration to applyMaxDurationSeconds", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["最长运行时长（当前：1800 秒）"]);
    ui.input = vi.fn().mockResolvedValue("3600");
    await handler.handle({ ui });
    expect(settings.applyMaxDurationSeconds).toHaveBeenCalledWith(3600);
    expect(ui.notify).toHaveBeenCalledWith("Max duration set to 3600 s", "info");
  });

  it("rejects a max duration below 1 with a warning", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["最长运行时长（当前：1800 秒）"]);
    ui.input = vi.fn().mockResolvedValue("0");
    await handler.handle({ ui });
    expect(settings.applyMaxDurationSeconds).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("请输入正整数。", "warning");
  });

  it("delegates a valid queue wait to applyMaxQueueWaitSeconds", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["最长排队等待（当前：900 秒）"]);
    ui.input = vi.fn().mockResolvedValue("600");
    await handler.handle({ ui });
    expect(settings.applyMaxQueueWaitSeconds).toHaveBeenCalledWith(600);
    expect(ui.notify).toHaveBeenCalledWith("Max queue wait set to 600 s", "info");
  });

  it("delegates a valid abort grace to applyAbortGraceSeconds", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["中止宽限期（当前：5 秒）"]);
    ui.input = vi.fn().mockResolvedValue("10");
    await handler.handle({ ui });
    expect(settings.applyAbortGraceSeconds).toHaveBeenCalledWith(10);
    expect(ui.notify).toHaveBeenCalledWith("Abort grace set to 10 s", "info");
  });

  it("rejects an abort grace below 1 with a warning", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["中止宽限期（当前：5 秒）"]);
    ui.input = vi.fn().mockResolvedValue("0");
    await handler.handle({ ui });
    expect(settings.applyAbortGraceSeconds).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("请输入正整数。", "warning");
  });
});

describe("SubagentsSettingsHandler — retention windows", () => {
  it("delegates a valid consumed window to applyConsumedSessionRetentionMinutes", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["已消费会话保留（当前：10 分钟）"]);
    ui.input = vi.fn().mockResolvedValue("30");
    await handler.handle({ ui });
    expect(settings.applyConsumedSessionRetentionMinutes).toHaveBeenCalledWith(30);
    expect(ui.notify).toHaveBeenCalledWith("Consumed-session retention set to 30 min", "info");
  });

  it("delegates a valid unconsumed window to applyUnconsumedSessionRetentionMinutes", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["未消费会话保留（当前：720 分钟）"]);
    ui.input = vi.fn().mockResolvedValue("1440");
    await handler.handle({ ui });
    expect(settings.applyUnconsumedSessionRetentionMinutes).toHaveBeenCalledWith(1440);
    expect(ui.notify).toHaveBeenCalledWith("Unconsumed-session retention set to 1440 min", "info");
  });

  it("rejects a consumed window below 1 with a warning and does not apply", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["已消费会话保留（当前：10 分钟）"]);
    ui.input = vi.fn().mockResolvedValue("0");
    await handler.handle({ ui });
    expect(settings.applyConsumedSessionRetentionMinutes).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("请输入正整数。", "warning");
  });
});

describe("SubagentsSettingsHandler — abort all subagents on ESC", () => {
  it("flips the policy directly and notifies the returned toast", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["ESC 中止全部子代理（当前：开）"]);
    await handler.handle({ ui });
    expect(settings.toggleAbortAllOnInterrupt).toHaveBeenCalledOnce();
    expect(ui.notify).toHaveBeenCalledWith("Abort all subagents on ESC: off", "info");
  });

  it("never prompts for input — the toggle is a direct flip", async () => {
    const { handler } = makeHandler();
    const ui = makeMenuUI(["ESC 中止全部子代理（当前：开）"]);
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
    const ui = makeMenuUI(["收尾轮次（当前：2）"]);
    ui.input = vi.fn().mockResolvedValue("3");
    await handler.handle({ ui });
    expect(settings.toggleAbortAllOnInterrupt).not.toHaveBeenCalled();
  });
});
