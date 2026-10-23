import { describe, expect, it } from "vitest";
import type { TypeListRegistry } from "#src/tools/helpers";
import {
  buildAgentGuidelines,
  buildDetails,
  buildTypeListText,
  formatLifetimeTokens,
  getModelLabelFromConfig,
  getOutcomeNote,
  textResult,
} from "#src/tools/helpers";
import type { AgentDetails } from "#src/ui/display";
import { createTestSubagent } from "#test/helpers/make-subagent";

function makeRegistry(opts: {
  defaults?: string[];
  users?: string[];
  resolve?: (name: string) => { description: string; model: string | undefined; enabled?: boolean; toolGuideline?: string };
}): TypeListRegistry {
  return {
    getDefaultAgentNames: () => opts.defaults ?? [],
    getUserAgentNames: () => opts.users ?? [],
    resolveAgentConfig: (name: string) => (
      { ...opts.resolve?.(name) ?? { description: "", model: undefined } }
    ) as ReturnType<TypeListRegistry["resolveAgentConfig"]>,
    getToolNamesForType: () => [],
  };
}

describe("textResult", () => {
  it("wraps text with optional details", () => {
    expect(textResult("hello")).toEqual({
      content: [{ type: "text", text: "hello" }],
      details: undefined,
    });

    const details: AgentDetails = {
      displayName: "Agent",
      description: "",
      subagentType: "general-purpose",
      toolUses: 0,
      tokens: "",
      durationMs: 0,
      phase: "terminal",
      outcome: "completed",
    };
    expect(textResult("done", details).details).toBe(details);
  });
});

describe("formatLifetimeTokens", () => {
  it("formats non-zero lifetime usage", () => {
    expect(formatLifetimeTokens({ lifetimeUsage: { input: 500, output: 500, cacheWrite: 0 } }))
      .toBe("1.0k token");
  });

  it("omits zero lifetime usage", () => {
    expect(formatLifetimeTokens({ lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 } }))
      .toBe("");
  });
});

describe("getOutcomeNote", () => {
  it("labels each non-success terminal outcome", () => {
    expect(getOutcomeNote("turn_limit")).toBe(" (Turn limit reached)");
    expect(getOutcomeNote("timeout")).toBe(" (Timed out)");
    expect(getOutcomeNote("queue_timeout")).toBe(" (Queue timed out)");
    expect(getOutcomeNote("cancelled")).toBe(" (Cancelled)");
  });

  it("distinguishes an agent cancelled while queued", () => {
    expect(getOutcomeNote("cancelled", true)).toBe(" (stopped before starting)");
  });

  it("does not add a completion note", () => {
    expect(getOutcomeNote("completed")).toBe("");
  });
});

describe("agent type presentation", () => {
  it("lists enabled default and custom agents", () => {
    const registry = makeRegistry({
      defaults: ["general-purpose", "disabled"],
      users: ["custom"],
      resolve: (name) => ({
        description: `${name} description`,
        model: name === "general-purpose" ? "anthropic/claude-haiku-4-5-20251001" : undefined,
        enabled: name === "disabled" ? false : undefined,
        toolGuideline: name === "general-purpose" ? "- Use it." : undefined,
      }),
    });

    const text = buildTypeListText(registry, "/home/.pi");
    expect(text).toContain("general-purpose description (claude-haiku-4-5)");
    expect(text).toContain("custom description");
    expect(text).not.toContain("disabled description");
    expect(buildAgentGuidelines(registry)).toEqual(["- Use it."]);
  });

  it("normalizes a configured model label", () => {
    expect(getModelLabelFromConfig("provider/sub/model-20251001")).toBe("model");
  });
});

describe("buildDetails", () => {
  const base = {
    displayName: "TestAgent",
    description: "does stuff",
    subagentType: "general-purpose",
    modelName: undefined,
    tags: undefined,
  };

  it("projects phase, outcome, and invocation metrics", () => {
    const record = createTestSubagent({
      invocationTurnCount: 7,
      lifetimeTurnCount: 12,
      maxTurns: 10,
    });
    const details = buildDetails(base, record);
    expect(details.phase).toBe("terminal");
    expect(details.outcome).toBe("completed");
    expect(details.invocationTurnCount).toBe(7);
    expect(details.lifetimeTurnCount).toBe(12);
    expect(details.maxTurns).toBe(10);
  });

  it("uses the completion time for duration", () => {
    const record = {
      toolUses: 3,
      startedAt: 1000,
      completedAt: 5000,
      phase: "terminal" as const,
      outcome: "completed" as const,
      id: "agent-42",
      lifetimeUsage: { input: 100, output: 50, cacheWrite: 0 },
    };
    const details = buildDetails(base, record);
    expect(details.durationMs).toBe(4000);
    expect(details.agentId).toBe("agent-42");
  });
});
