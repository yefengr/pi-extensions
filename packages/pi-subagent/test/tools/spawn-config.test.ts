import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { resolveSpawnConfig, type SpawnSettings } from "#src/tools/spawn-config";
import type { AgentConfig } from "#src/types";
import { makeModel } from "#test/helpers/make-model";

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "Test agent",
    toolNames: ["read", "grep"],
    systemPrompt: "You are a test agent.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    ...overrides,
  };
}

/** Registry with a single disabled Plan setting. */
function makeDisabledPlanRegistry(): AgentTypeRegistry {
  return new AgentTypeRegistry(
    () => new Map([["Plan", makeAgentConfig({ name: "Plan", description: "Disabled" })]]),
    {
      reload: () => {},
      getState: (name) => ({ enabled: name !== "Plan", source: name === "Plan" ? "global" : "default" }),
    },
  );
}

/** Registry with one profile that pins runtime budgets. */
function makeBudgetProfileRegistry(budgets: Partial<AgentConfig>): AgentTypeRegistry {
  return new AgentTypeRegistry(
    () => new Map([["budgeted", makeAgentConfig({ name: "budgeted", ...budgets })]]),
  );
}

/** Minimal registry with default agents only. */
const testRegistry = new AgentTypeRegistry(() => new Map());

/** Shorthand for building ModelInfo. */
function makeModelInfo(overrides: Partial<Parameters<typeof resolveSpawnConfig>[2]> = {}) {
  return {
    parentModel: makeModel({ id: "claude-sonnet", name: "Claude Sonnet" }),
    modelRegistry: { find: () => undefined, getAll: () => [], getAvailable: () => [] },
    ...overrides,
  };
}

/** Global settings always define every budget: these are the SettingsManager defaults. */
const defaultSettings: SpawnSettings = {
  maxTurns: 30,
  wrapUpTurns: 2,
  maxDurationSeconds: 1800,
};

describe("resolveSpawnConfig — type resolution", () => {
  it("resolves a known agent type", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    expect("error" in result && result.error).toBeFalsy();
    if ("error" in result) return;
    expect(result.identity.subagentType).toBe("general-purpose");
    expect(result.identity.fellBack).toBe(false);
  });

  it("falls back to general-purpose for unknown agent type", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "unknown-type", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    expect("error" in result && result.error).toBeFalsy();
    if ("error" in result) return;
    expect(result.identity.subagentType).toBe("general-purpose");
    expect(result.identity.fellBack).toBe(true);
  });

  it("sets displayName from registry", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "Explore", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.identity.displayName).toBe("Explore");
  });

  it("returns an error for a disabled agent type (exact match)", () => {
    const registry = makeDisabledPlanRegistry();
    const result = resolveSpawnConfig(
      { subagent_type: "Plan", prompt: "test", description: "d" },
      registry,
      makeModelInfo(),
      defaultSettings,
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe('Agent type "Plan" is disabled');
    }
  });

  it("reports the canonical casing in the disabled-agent error (case-insensitive input)", () => {
    const registry = makeDisabledPlanRegistry();
    const result = resolveSpawnConfig(
      { subagent_type: "plan", prompt: "test", description: "d" },
      registry,
      makeModelInfo(),
      defaultSettings,
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe('Agent type "Plan" is disabled');
    }
  });

  it("uses displayName from agent config when available", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    // general-purpose config has displayName: "Agent"
    expect(result.identity.displayName).toBe("Agent");
  });
});

describe("resolveSpawnConfig — model resolution", () => {
  it("inherits parent model when no model specified", () => {
    const parentModel = makeModel({ id: "claude-sonnet", name: "Claude Sonnet" });
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo({ parentModel }),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.model).toBe(parentModel);
    // modelName is undefined when same as parent
    expect(result.presentation.modelName).toBeUndefined();
  });

  it("returns error when user-specified model cannot be resolved", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d", model: "nonexistent-xyz" },
      testRegistry,
      makeModelInfo({ modelRegistry: { find: () => undefined, getAll: () => [], getAvailable: () => [] } }),
      defaultSettings,
    );
    expect("error" in result && result.error).toBeTruthy();
  });

  it("resolves a profile-pinned exact model", () => {
    const pinned = makeModel({ provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" });
    const registry = makeBudgetProfileRegistry({ model: "anthropic/claude-sonnet-4-6" });
    const result = resolveSpawnConfig(
      { subagent_type: "budgeted", prompt: "test", description: "d" },
      registry,
      makeModelInfo({
        modelRegistry: {
          find: (provider, modelId) =>
            provider === pinned.provider && modelId === pinned.id ? pinned : undefined,
          getAll: () => [pinned],
          getAvailable: () => [pinned],
        },
      }),
      defaultSettings,
    );
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.execution.model).toBe(pinned);
  });

  it("rejects an explicitly empty profile model instead of inheriting the parent", () => {
    const registry = makeBudgetProfileRegistry({ model: "" });
    const result = resolveSpawnConfig(
      { subagent_type: "budgeted", prompt: "test", description: "d" },
      registry,
      makeModelInfo(),
      defaultSettings,
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Model not found");
      expect(result.error).toContain("agent profile");
    }
  });

  it("rejects an all-whitespace tool-call model instead of fuzzy-matching one", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d", model: "   " },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Model not found");
      expect(result.error).toContain("tool parameter");
    }
  });

  it("rejects a profile pin that only fuzzy-matches a sibling model", () => {
    const parentModel = makeModel({ id: "claude-sonnet", name: "Claude Sonnet" });
    const sibling = makeModel({ provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" });
    const registry = makeBudgetProfileRegistry({ model: "anthropic/claude-opus-4" });
    const result = resolveSpawnConfig(
      { subagent_type: "budgeted", prompt: "test", description: "d" },
      registry,
      makeModelInfo({
        parentModel,
        modelRegistry: {
          find: (provider, modelId) =>
            provider === sibling.provider && modelId === sibling.id ? sibling : undefined,
          getAll: () => [sibling],
          getAvailable: () => [sibling],
        },
      }),
      defaultSettings,
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Model not found");
      expect(result.error).toContain("agent profile");
    }
  });

  it("rejects a profile pin for an unauthenticated model instead of inheriting the parent", () => {
    const parentModel = makeModel({ id: "claude-sonnet", name: "Claude Sonnet" });
    const unauthenticated = makeModel({ provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" });
    const registry = makeBudgetProfileRegistry({ model: "anthropic/claude-opus-4-6" });
    const result = resolveSpawnConfig(
      { subagent_type: "budgeted", prompt: "test", description: "d" },
      registry,
      makeModelInfo({
        parentModel,
        modelRegistry: {
          find: () => unauthenticated,
          getAll: () => [unauthenticated],
          getAvailable: () => [],
        },
      }),
      defaultSettings,
    );
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("Model not found");
  });

  it("returns an error when a profile pin has no model registry", () => {
    const registry = makeBudgetProfileRegistry({ model: "anthropic/claude-opus-4-6" });
    const result = resolveSpawnConfig(
      { subagent_type: "budgeted", prompt: "test", description: "d" },
      registry,
      makeModelInfo({ modelRegistry: undefined }),
      defaultSettings,
    );
    expect("error" in result && result.error).toBe("No model registry available.");
  });

  it("rejects a tool-call pin for an unregistered provider without fuzzy fallback", () => {
    const available = makeModel({ provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" });
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d", model: "openai-codex/claude-opus-4-6" },
      testRegistry,
      makeModelInfo({
        modelRegistry: {
          find: (provider, modelId) =>
            provider === available.provider && modelId === available.id ? available : undefined,
          getAll: () => [available],
          getAvailable: () => [available],
        },
      }),
      defaultSettings,
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Model not found");
      expect(result.error).toContain("tool parameter");
    }
  });
});

describe("resolveSpawnConfig — effective turn budget", () => {
  it("uses the global maxTurns when neither profile nor params specify one", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.effectiveMaxTurns).toBe(30);
  });

  it("lets a tool-call max_turns tighten the global budget", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d", max_turns: 10 },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.effectiveMaxTurns).toBe(10);
  });

  it("ignores a tool-call max_turns that tries to raise the global budget", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d", max_turns: 100 },
      testRegistry,
      makeModelInfo(),
      { ...defaultSettings, maxTurns: 25 },
    );
    if ("error" in result) return;
    expect(result.execution.effectiveMaxTurns).toBe(25);
  });

  it("lets an agent profile tighten the global budget", () => {
    const registry = makeBudgetProfileRegistry({ maxTurns: 12 });
    const result = resolveSpawnConfig(
      { subagent_type: "budgeted", prompt: "test", description: "d" },
      registry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.effectiveMaxTurns).toBe(12);
  });

  it("lets a tool-call max_turns tighten a profile budget", () => {
    const registry = makeBudgetProfileRegistry({ maxTurns: 42 });
    const result = resolveSpawnConfig(
      { subagent_type: "budgeted", prompt: "test", description: "d", max_turns: 1 },
      registry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.effectiveMaxTurns).toBe(1);
  });

  it("takes the minimum across global, profile, and tool-call budgets", () => {
    const registry = makeBudgetProfileRegistry({ maxTurns: 15 });
    const result = resolveSpawnConfig(
      { subagent_type: "budgeted", prompt: "test", description: "d", max_turns: 10 },
      registry,
      makeModelInfo(),
      { ...defaultSettings, maxTurns: 20 },
    );
    if ("error" in result) return;
    expect(result.execution.effectiveMaxTurns).toBe(10);
  });

  it("lets the global budget keep a looser profile in check", () => {
    const registry = makeBudgetProfileRegistry({ maxTurns: 25 });
    const result = resolveSpawnConfig(
      { subagent_type: "budgeted", prompt: "test", description: "d" },
      registry,
      makeModelInfo(),
      { ...defaultSettings, maxTurns: 8 },
    );
    if ("error" in result) return;
    expect(result.execution.effectiveMaxTurns).toBe(8);
  });
});

describe("resolveSpawnConfig — effective duration budget", () => {
  it("uses the global maxDurationSeconds by default", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.effectiveMaxDurationSeconds).toBe(1800);
  });

  it("lets a tool-call max_duration_seconds tighten the global budget", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d", max_duration_seconds: 120 },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.effectiveMaxDurationSeconds).toBe(120);
  });

  it("lets a profile budget tighten the global budget and a tool call tighten the profile", () => {
    const registry = makeBudgetProfileRegistry({ maxDurationSeconds: 600 });
    const fromProfile = resolveSpawnConfig(
      { subagent_type: "budgeted", prompt: "test", description: "d" },
      registry,
      makeModelInfo(),
      defaultSettings,
    );
    if (!("error" in fromProfile)) {
      expect(fromProfile.execution.effectiveMaxDurationSeconds).toBe(600);
    }

    const fromParam = resolveSpawnConfig(
      { subagent_type: "budgeted", prompt: "test", description: "d", max_duration_seconds: 60 },
      registry,
      makeModelInfo(),
      defaultSettings,
    );
    if (!("error" in fromParam)) {
      expect(fromParam.execution.effectiveMaxDurationSeconds).toBe(60);
    }
  });

  it("ignores a tool-call duration that tries to raise a tighter profile budget", () => {
    const registry = makeBudgetProfileRegistry({ maxDurationSeconds: 600 });
    const result = resolveSpawnConfig(
      { subagent_type: "budgeted", prompt: "test", description: "d", max_duration_seconds: 3600 },
      registry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.effectiveMaxDurationSeconds).toBe(600);
  });
});

describe("resolveSpawnConfig — effective wrap-up turns", () => {
  it("uses the global wrapUpTurns when neither profile nor params specify one", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.effectiveWrapUpTurns).toBe(2);
  });

  it("prefers the profile wrap_up_turns over the global value", () => {
    const registry = makeBudgetProfileRegistry({ wrapUpTurns: 5 });
    const result = resolveSpawnConfig(
      { subagent_type: "budgeted", prompt: "test", description: "d" },
      registry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.effectiveWrapUpTurns).toBe(5);
  });

  it("prefers the tool-call wrap_up_turns over the profile value", () => {
    const registry = makeBudgetProfileRegistry({ wrapUpTurns: 5 });
    const result = resolveSpawnConfig(
      { subagent_type: "budgeted", prompt: "test", description: "d", wrap_up_turns: 3 },
      registry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.effectiveWrapUpTurns).toBe(3);
  });

  it("accepts an explicit 0 wrap-up window", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d", wrap_up_turns: 0 },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.effectiveWrapUpTurns).toBe(0);
  });

  it("clamps the wrap-up window below the effective turn budget", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d", max_turns: 1, wrap_up_turns: 5 },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.effectiveMaxTurns).toBe(1);
    expect(result.execution.effectiveWrapUpTurns).toBe(0);
  });

  it("clamps a loose global wrap-up window below a tighter effective turn budget", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d", max_turns: 3 },
      testRegistry,
      makeModelInfo(),
      { ...defaultSettings, wrapUpTurns: 20 },
    );
    if ("error" in result) return;
    expect(result.execution.effectiveMaxTurns).toBe(3);
    expect(result.execution.effectiveWrapUpTurns).toBe(2);
  });
});

describe("resolveSpawnConfig — invocation fields", () => {
  it("sets runInBackground from params", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d", run_in_background: true },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.runInBackground).toBe(true);
  });

  it("builds agentInvocation snapshot with no explicit budgets", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d", thinking: "high" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.agentInvocation).toEqual({
      modelName: undefined,
      thinking: "high",
      maxTurns: undefined,
      wrapUpTurns: undefined,
      maxDurationSeconds: undefined,
      inheritContext: false,
      runInBackground: false,
    });
  });

  it("records explicit profile and tool-call budgets on agentInvocation", () => {
    const registry = makeBudgetProfileRegistry({
      maxTurns: 15,
      wrapUpTurns: 4,
      maxDurationSeconds: 900,
    });
    const result = resolveSpawnConfig(
      {
        subagent_type: "budgeted",
        prompt: "test",
        description: "d",
        max_turns: 10,
        wrap_up_turns: 3,
        max_duration_seconds: 300,
      },
      registry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.agentInvocation.maxTurns).toBe(10);
    expect(result.execution.agentInvocation.wrapUpTurns).toBe(3);
    expect(result.execution.agentInvocation.maxDurationSeconds).toBe(300);
    // Effective values stay a separate concern on execution.
    expect(result.execution.effectiveMaxTurns).toBe(10);
    expect(result.execution.effectiveWrapUpTurns).toBe(3);
    expect(result.execution.effectiveMaxDurationSeconds).toBe(300);
  });
});

describe("resolveSpawnConfig — detailBase and tags", () => {
  it("builds detailBase with description from params", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "my task" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.presentation.detailBase.description).toBe("my task");
    expect(result.presentation.detailBase.subagentType).toBe("general-purpose");
    expect(result.presentation.detailBase.displayName).toBe("Agent");
  });

  it("includes thinking tag when thinking is set", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d", thinking: "high" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.presentation.agentTags).toContain("thinking: high");
  });

  it("omits mode label for replace-mode agents", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "Explore", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    // Explore has promptMode: "replace" → no mode label, no invocation overrides
    expect(result.presentation.agentTags).toEqual([]);
  });

  it("includes twin tag for append-mode agents like general-purpose", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    // general-purpose has promptMode: "append" → gets "twin" label
    expect(result.presentation.agentTags).toContain("twin");
  });

  it("sets tags to undefined on detailBase for replace-mode agents with no invocation overrides", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "Explore", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    // Explore has promptMode: "replace" and no invocation overrides → no tags
    expect(result.presentation.detailBase.tags).toBeUndefined();
  });
});

describe("resolveSpawnConfig — prompt and rawType passthrough", () => {
  it("passes through prompt and rawType", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "Explore", prompt: "search for bugs", description: "bug search" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.prompt).toBe("search for bugs");
    expect(result.identity.rawType).toBe("Explore");
  });
});
