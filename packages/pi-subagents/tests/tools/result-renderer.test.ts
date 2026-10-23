import { describe, expect, it } from "vitest";
import {
  renderAgentResult,
  renderBackground,
  renderCompleted,
  renderFailed,
  renderRunning,
  renderStats,
} from "#src/tools/result-renderer";
import type { AgentDetails, Theme } from "#src/ui/display";

function makeTheme(): Theme {
  return {
    fg: (color: string, text: string) => `[${color}:${text}]`,
    bold: (text: string) => `**${text}**`,
  };
}

function makeDetails(overrides: Partial<AgentDetails> = {}): AgentDetails {
  return {
    displayName: "TestAgent",
    description: "test task",
    subagentType: "general-purpose",
    toolUses: 0,
    tokens: "",
    durationMs: 2000,
    phase: "terminal",
    outcome: "completed",
    ...overrides,
  };
}

describe("renderStats", () => {
  const theme = makeTheme();

  it("returns empty string when all stats are empty", () => {
    expect(renderStats(makeDetails(), theme)).toBe("");
  });

  it("renders model, tags, invocation turns, tools, and tokens", () => {
    const result = renderStats(makeDetails({
      modelName: "haiku",
      tags: ["thinking: high"],
      invocationTurnCount: 5,
      maxTurns: 30,
      toolUses: 2,
      tokens: "33.8k token",
    }), theme);
    expect(result).toBe(
      "[dim:haiku] [dim:·] [dim:thinking: high] [dim:·] [dim:↻5≤30] [dim:·] [dim:2 tool uses] [dim:·] [dim:33.8k token]",
    );
  });

  it("omits zero and absent turn counts", () => {
    expect(renderStats(makeDetails({ invocationTurnCount: 0 }), theme)).toBe("");
    expect(renderStats(makeDetails({ invocationTurnCount: undefined }), theme)).toBe("");
  });
});

describe("renderRunning", () => {
  const theme = makeTheme();

  it("renders spinner and activity", () => {
    const result = renderRunning(makeDetails({ phase: "running", spinnerFrame: 1, activity: "reading files" }), theme);
    expect(result).toContain("[accent:⠙]");
    expect(result).toContain("reading files");
  });

  it("uses defaults for missing spinner and activity", () => {
    const result = renderRunning(makeDetails({ phase: "running" }), theme);
    expect(result).toContain("[accent:⠋]");
    expect(result).toContain("thinking…");
  });
});

describe("renderBackground", () => {
  const theme = makeTheme();

  it("includes the detached agent ID", () => {
    expect(renderBackground(makeDetails({ phase: "background", agentId: "agent-42" }), theme))
      .toBe("[dim:  ⎿  Running in background (ID: agent-42)]");
  });
});

describe("renderCompleted", () => {
  const theme = makeTheme();

  it("uses a success icon and duration", () => {
    const result = renderCompleted(makeDetails({ durationMs: 3500 }), "", false, theme);
    expect(result).toContain("[success:✓]");
    expect(result).toContain("[dim:3.5s]");
    expect(result).toContain("Done");
  });

  it("renders expanded result text and caps it at 50 lines", () => {
    const manyLines = Array.from({ length: 55 }, (_, index) => `line ${index + 1}`).join("\n");
    const result = renderCompleted(makeDetails(), manyLines, true, theme);
    expect(result).toContain("[dim:  line 50]");
    expect(result).not.toContain("[dim:  line 51]");
    expect(result).toContain("use get_subagent_result with verbose");
  });
});

describe("renderFailed", () => {
  const theme = makeTheme();

  it.each([
    ["turn_limit", "Turn limit reached"],
    ["timeout", "Timed out"],
    ["queue_timeout", "Queue timed out"],
    ["cancelled", "Cancelled"],
  ] as const)("renders %s as a warning outcome", (outcome, label) => {
    const result = renderFailed(makeDetails({ outcome }), theme);
    expect(result).toContain("[error:✗]");
    expect(result).toContain(`[warning:  ⎿  ${label}]`);
  });

  it("renders error details", () => {
    expect(renderFailed(makeDetails({ outcome: "error", error: "Out of context" }), theme))
      .toContain("[error:  ⎿  Error: Out of context]");
  });
});

describe("renderAgentResult", () => {
  const theme = makeTheme();

  it("dispatches queued/running and partial results to running", () => {
    expect(renderAgentResult(makeDetails({ phase: "queued", outcome: undefined }), "", false, false, theme))
      .toContain("[accent:⠋]");
    expect(renderAgentResult(makeDetails({ phase: "terminal", outcome: "completed" }), "", false, true, theme))
      .toContain("[accent:⠋]");
  });

  it("dispatches the detached background acknowledgement", () => {
    expect(renderAgentResult(makeDetails({ phase: "background", agentId: "agent-99" }), "", false, false, theme))
      .toContain("agent-99");
  });

  it("dispatches completed and failed terminal outcomes", () => {
    expect(renderAgentResult(makeDetails({ phase: "terminal", outcome: "completed" }), "", false, false, theme))
      .toContain("[success:✓]");
    expect(renderAgentResult(makeDetails({ phase: "terminal", outcome: "timeout" }), "", false, false, theme))
      .toContain("Timed out");
  });
});
