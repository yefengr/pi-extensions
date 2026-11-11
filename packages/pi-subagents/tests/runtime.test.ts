import type { BeforeAgentStartEvent, BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { createSubagentRuntime, SubagentRuntime } from "#src/runtime";
import type { SessionContext } from "#src/types";
import { makeModel } from "#test/helpers/make-model";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

const mockBuildParentSnapshot = vi.hoisted(() =>
  vi.fn<(ctx: SessionContext, inheritContext?: boolean, options?: BuildSystemPromptOptions) => ParentSnapshot>(),
);

vi.mock("#src/lifecycle/parent-snapshot", () => ({
  buildParentSnapshot: mockBuildParentSnapshot,
}));

function makeSessionCtx(overrides?: Partial<SessionContext>): SessionContext {
  return {
    cwd: "/test/cwd",
    model: undefined,
    modelRegistry: { find: () => undefined, getAll: () => [] },
    getSystemPrompt: () => "test prompt",
    sessionManager: {
      getSessionFile: () => "/sessions/test.jsonl",
      getSessionId: () => "test-session-id",
      getBranch: () => [],
    },
    ...overrides,
  };
}

describe("createSubagentRuntime", () => {
  it("returns correct defaults", () => {
    const runtime = createSubagentRuntime();
    expect(runtime.currentCtx).toBeUndefined();
  });

  it("currentCtx is the stored SessionContext after setSessionContext", () => {
    const runtime = createSubagentRuntime();
    const ctx = makeSessionCtx();
    runtime.setSessionContext(ctx);
    expect(runtime.currentCtx).toBe(ctx);
  });
});

describe("SubagentRuntime class", () => {
  it("is a class — instances are created with new", () => {
    const runtime = new SubagentRuntime();
    expect(runtime).toBeInstanceOf(SubagentRuntime);
  });

  it("createSubagentRuntime returns an instance of the class", () => {
    const runtime = createSubagentRuntime();
    expect(runtime).toBeInstanceOf(SubagentRuntime);
  });
});

describe("SubagentRuntime session-context methods", () => {
  it("setSessionContext stores the provided SessionContext directly", () => {
    const runtime = createSubagentRuntime();
    const ctx = makeSessionCtx();
    runtime.setSessionContext(ctx);
    expect(runtime.currentCtx).toBe(ctx);
  });

  it("clearSessionContext resets currentCtx to undefined", () => {
    const runtime = createSubagentRuntime();
    runtime.setSessionContext(makeSessionCtx());
    expect(runtime.currentCtx).toBeDefined();
    runtime.clearSessionContext();
    expect(runtime.currentCtx).toBeUndefined();
  });

  it("round-trip: set then clear returns to initial state", () => {
    const runtime = createSubagentRuntime();
    expect(runtime.currentCtx).toBeUndefined();
    const ctx = makeSessionCtx();
    runtime.setSessionContext(ctx);
    expect(runtime.currentCtx).toBe(ctx);
    runtime.clearSessionContext();
    expect(runtime.currentCtx).toBeUndefined();
  });
});

describe("SubagentRuntime context query methods", () => {
  beforeEach(() => {
    mockBuildParentSnapshot.mockReset();
  });

  it("buildSnapshot delegates to buildParentSnapshot with the current context and inheritContext flag", () => {
    const runtime = createSubagentRuntime();
    const ctx = makeSessionCtx();
    runtime.setSessionContext(ctx);
    mockBuildParentSnapshot.mockReturnValueOnce(STUB_SNAPSHOT);
    const result = runtime.buildSnapshot(true);
    expect(mockBuildParentSnapshot).toHaveBeenCalledWith(ctx, true);
    expect(result).toBe(STUB_SNAPSHOT);
  });

  it("buildSnapshot passes false inheritContext correctly", () => {
    const runtime = createSubagentRuntime();
    const ctx = makeSessionCtx();
    runtime.setSessionContext(ctx);
    mockBuildParentSnapshot.mockReturnValueOnce(STUB_SNAPSHOT);
    runtime.buildSnapshot(false);
    expect(mockBuildParentSnapshot).toHaveBeenCalledWith(ctx, false);
  });

  it("captures later structured handler changes and snapshots the final matching prompt", () => {
    const runtime = createSubagentRuntime(() => ["read", "codemode"]);
    const options: BuildSystemPromptOptions = { cwd: "/test/cwd", sections: { operator: "first" } };
    const event = {
      type: "before_agent_start", messageType: "user", prompt: "task",
      systemPromptOptions: options,
      get systemPrompt() { return JSON.stringify(options); },
    } as BeforeAgentStartEvent;
    const ctx = makeSessionCtx({ isProjectTrusted: () => true, getSystemPrompt: () => event.systemPrompt });
    runtime.setSessionContext(ctx);
    runtime.capturePrompt(event);
    options.sections = { operator: "later handler" };
    runtime.confirmPrompt(ctx);
    mockBuildParentSnapshot.mockReturnValueOnce({ ...STUB_SNAPSHOT });
    const snapshot = runtime.buildSnapshot(false);
    expect(mockBuildParentSnapshot).toHaveBeenCalledWith(ctx, false, options);
    expect(snapshot.availableTools).toEqual(["read", "codemode"]);
    options.sections.operator = "mutated after capture";
    expect(mockBuildParentSnapshot.mock.calls[0][2]?.sections?.operator).toBe("later handler");
  });

  it("rejects forceSystemPrompt added after capture or after confirmation, including empty text", () => {
    for (const afterConfirmation of [false, true]) {
      const runtime = createSubagentRuntime();
      const options: BuildSystemPromptOptions = { cwd: "/test/cwd" };
      const event = {
        type: "before_agent_start", messageType: "user", prompt: "task", systemPromptOptions: options,
        get systemPrompt() { return options.forceSystemPrompt ?? "effective"; },
      } as BeforeAgentStartEvent;
      const ctx = makeSessionCtx({ isProjectTrusted: () => false, getSystemPrompt: () => event.systemPrompt });
      runtime.setSessionContext(ctx);
      runtime.capturePrompt(event);
      if (!afterConfirmation) options.forceSystemPrompt = "";
      runtime.confirmPrompt(ctx);
      if (afterConfirmation) options.forceSystemPrompt = "";
      expect(() => runtime.buildSnapshot(false)).toThrow("opaque forceSystemPrompt");
    }
  });

  it("rejects missing, mismatched, and invalidated structured state in real SDK contexts", () => {
    const runtime = createSubagentRuntime();
    let effective = "effective";
    const ctx = makeSessionCtx({ isProjectTrusted: () => true, getSystemPrompt: () => effective });
    runtime.setSessionContext(ctx);
    expect(() => runtime.buildSnapshot(false)).toThrow("structured system prompt");
    const event = {
      type: "before_agent_start", messageType: "user", prompt: "task",
      systemPrompt: "effective", systemPromptOptions: { cwd: "/test/cwd" },
    } as BeforeAgentStartEvent;
    runtime.capturePrompt(event);
    runtime.confirmPrompt(ctx);
    effective = "changed before dispatch";
    expect(() => runtime.buildSnapshot(false)).toThrow("no longer matches");
    runtime.clearSessionContext();
    runtime.setSessionContext(ctx);
    expect(() => runtime.buildSnapshot(false)).toThrow("structured system prompt");
  });

  it("getModelInfo returns model and modelRegistry from current context", () => {
    const runtime = createSubagentRuntime();
    const registry = { find: () => undefined, getAll: () => [], getAvailable: () => [] };
    const model = makeModel({ id: "claude-sonnet", name: "Claude Sonnet" });
    const ctx = makeSessionCtx({ model, modelRegistry: registry });
    runtime.setSessionContext(ctx);
    const info = runtime.getModelInfo();
    expect(info.parentModel).toBe(model);
    expect(info.modelRegistry).toBe(registry);
  });

  it("getModelInfo returns undefined parentModel when context model is undefined", () => {
    const runtime = createSubagentRuntime();
    const ctx = makeSessionCtx({ model: undefined });
    runtime.setSessionContext(ctx);
    const info = runtime.getModelInfo();
    expect(info.parentModel).toBeUndefined();
  });

  it("getSessionInfo returns session file and id from sessionManager", () => {
    const runtime = createSubagentRuntime();
    const ctx = makeSessionCtx({
      sessionManager: {
        getSessionFile: () => "/sessions/parent.jsonl",
        getSessionId: () => "session-42",
        getBranch: () => [],
      },
    });
    runtime.setSessionContext(ctx);
    const info = runtime.getSessionInfo();
    expect(info.parentSessionFile).toBe("/sessions/parent.jsonl");
    expect(info.parentSessionId).toBe("session-42");
  });

  it("getSessionInfo uses empty string when getSessionFile returns undefined", () => {
    const runtime = createSubagentRuntime();
    const ctx = makeSessionCtx({
      sessionManager: {
        getSessionFile: () => undefined,
        getSessionId: () => "session-99",
        getBranch: () => [],
      },
    });
    runtime.setSessionContext(ctx);
    const info = runtime.getSessionInfo();
    expect(info.parentSessionFile).toBe("");
    expect(info.parentSessionId).toBe("session-99");
  });
});
