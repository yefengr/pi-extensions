import { describe, expect, it } from "vitest";
import { resolveAgentInvocationConfig } from "#src/config/invocation-config";
import type { AgentConfig } from "#src/types";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Explore",
    description: "Explore",
    toolNames: ["read"],
    systemPrompt: "Test agent",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    ...overrides,
  };
}

describe("resolveAgentInvocationConfig", () => {
  it("prefers agent config over tool-call params for model, thinking, and strategy fields", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        model: "provider/config-model",
        thinking: "high",
        inheritContext: false,
        runInBackground: false,
      }),
      {
        model: "provider/param-model",
        thinking: "minimal",
        inherit_context: true,
        run_in_background: true,
      },
    );

    expect(resolved.modelInput).toBe("provider/config-model");
    expect(resolved.modelFromParams).toBe(false);
    expect(resolved.thinking).toBe("high");
    expect(resolved.inheritContext).toBe(false);
    expect(resolved.runInBackground).toBe(false);
  });

  it("uses tool-call params when no agent config is available", () => {
    const resolved = resolveAgentInvocationConfig(undefined, {
      model: "provider/param-model",
      thinking: "minimal",
      max_turns: 3,
      wrap_up_turns: 1,
      max_duration_seconds: 60,
      inherit_context: true,
      run_in_background: true,
    });

    expect(resolved.modelInput).toBe("provider/param-model");
    expect(resolved.modelFromParams).toBe(true);
    expect(resolved.thinking).toBe("minimal");
    expect(resolved.maxTurns).toBe(3);
    expect(resolved.wrapUpTurns).toBe(1);
    expect(resolved.maxDurationSeconds).toBe(60);
    expect(resolved.inheritContext).toBe(true);
    expect(resolved.runInBackground).toBe(true);
  });

  it("lets parent fill in booleans when config leaves them undefined", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        inheritContext: undefined,
        runInBackground: undefined,
      }),
      {
        inherit_context: true,
        run_in_background: true,
      },
    );

    expect(resolved.inheritContext).toBe(true);
    expect(resolved.runInBackground).toBe(true);
  });

  it("defaults booleans to false when neither config nor params set them", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        inheritContext: undefined,
        runInBackground: undefined,
      }),
      {},
    );

    expect(resolved.inheritContext).toBe(false);
    expect(resolved.runInBackground).toBe(false);
    expect(resolved.maxTurns).toBeUndefined();
    expect(resolved.wrapUpTurns).toBeUndefined();
    expect(resolved.maxDurationSeconds).toBeUndefined();
  });

  describe("tighten-only budgets", () => {
    it("takes the smaller of the profile and tool-call max_turns values", () => {
      const resolved = resolveAgentInvocationConfig(
        makeConfig({ maxTurns: 42 }),
        { max_turns: 1 },
      );
      expect(resolved.maxTurns).toBe(1);
    });

    it("keeps the profile max_turns when it is the tighter value", () => {
      const resolved = resolveAgentInvocationConfig(
        makeConfig({ maxTurns: 5 }),
        { max_turns: 40 },
      );
      expect(resolved.maxTurns).toBe(5);
    });

    it("takes the smaller of the profile and tool-call max_duration_seconds values", () => {
      const resolved = resolveAgentInvocationConfig(
        makeConfig({ maxDurationSeconds: 900 }),
        { max_duration_seconds: 120 },
      );
      expect(resolved.maxDurationSeconds).toBe(120);
    });
  });

  describe("wrap-up precedence", () => {
    it("prefers the tool-call wrap_up_turns over the profile value", () => {
      const resolved = resolveAgentInvocationConfig(
        makeConfig({ wrapUpTurns: 5 }),
        { wrap_up_turns: 3 },
      );
      expect(resolved.wrapUpTurns).toBe(3);
    });

    it("falls back to the profile wrap_up_turns when the tool call omits it", () => {
      const resolved = resolveAgentInvocationConfig(
        makeConfig({ wrapUpTurns: 5 }),
        {},
      );
      expect(resolved.wrapUpTurns).toBe(5);
    });

    it("honors an explicit 0 from the tool call (not a falsy fallback)", () => {
      const resolved = resolveAgentInvocationConfig(
        makeConfig({ wrapUpTurns: 5 }),
        { wrap_up_turns: 0 },
      );
      expect(resolved.wrapUpTurns).toBe(0);
    });
  });
});
