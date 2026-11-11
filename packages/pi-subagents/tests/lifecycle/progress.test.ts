import { describe, expect, it } from "vitest";
import { getSubagentProgress, type ProgressSource } from "#src/lifecycle/progress";

const source = (overrides: Partial<ProgressSource> = {}): ProgressSource => ({
  phase: "running", invocationTurnCount: 2, maxTurns: 8,
  activeTools: new Map(), responseText: "", ...overrides,
});

describe("shared observed-progress projection", () => {
  it("does not invent a timestamp, progress or a stalled diagnosis", () => {
    expect(getSubagentProgress(source(), 10_000)).toEqual({
      activity: "Running; no activity observed yet", invocationTurnCount: 2, maxTurns: 8,
    });
  });

  it("reports observed tool names without exposing streamed response contents", () => {
    const progress = getSubagentProgress(source({ activeTools: new Map([["1", "read"], ["2", "bash"]]),
      responseText: "private streamed answer", observedActivity: "tool" }));
    expect(progress.activity).toBe("Running tools: read, bash");
    expect(JSON.stringify(progress)).not.toContain("private streamed answer");
  });

  it.each(["model", "response", "compacting"] as const)("projects the observed %s activity", (observedActivity) => {
    const progress = getSubagentProgress(source({ observedActivity, lastProgressAt: 1000 }), 2500);
    expect(progress.sinceLastProgressMs).toBe(1500);
    expect(progress.activity).not.toContain("no activity");
  });

  it("reads age without advancing observed time and tolerates a backward clock", () => {
    const record = source({ lastProgressAt: 2000, observedActivity: "model" });
    expect(getSubagentProgress(record, 1000).sinceLastProgressMs).toBe(0);
    expect(getSubagentProgress(record, 7000).sinceLastProgressMs).toBe(5000);
    expect(record.lastProgressAt).toBe(2000);
  });

  it("does not let an old response mask a later model or tool observation", () => {
    expect(getSubagentProgress(source({ observedActivity: "model", responseText: "old text" })).activity).toBe("Model turn in progress");
    expect(getSubagentProgress(source({ observedActivity: "tool", responseText: "old text" })).activity).toBe("Tool activity observed");
  });

  it("phase takes priority over old or late activity", () => {
    expect(getSubagentProgress(source({ phase: "queued", responseText: "old" })).activity).toBe("Queued");
    expect(getSubagentProgress(source({ phase: "terminal", activeTools: new Map([["1", "read"]]) })).activity).toBe("Terminal state");
  });
});
