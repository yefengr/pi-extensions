import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubagentSession, type SubagentSessionMeta } from "#src/lifecycle/subagent-session";
import { createChildLifecycleMock } from "#test/helpers/subagent-session-io";

// ── Session mock factory ───────────────────────────────────────────────────────

/**
 * Subscribable session stub whose `prompt()` appends a final assistant message.
 * `listeners` lets tests drive turn_end events for turn-limit assertions.
 */
function createSession(finalText: string) {
  const listeners: Array<(event: any) => void> = [];
  /** Teardown call order — the shutdown emit must precede session disposal. */
  const calls: string[] = [];
  const session = {
    messages: [] as unknown[],
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    prompt: vi.fn(async () => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: finalText }],
      });
    }),
    abort: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(() => {
      calls.push("dispose");
    }),
    hasExtensionHandlers: vi.fn((_eventType: string): boolean => true),
    extensionRunner: {
      emit: vi.fn((_event: unknown): Promise<unknown> => {
        calls.push("emit");
        return Promise.resolve(undefined);
      }),
    },
    getSessionStats: vi.fn(() => ({
      tokens: { input: 100, output: 50, cacheWrite: 10 },
      contextUsage: { percent: 42 },
    })),
    getToolDefinition: vi.fn((_name: string): unknown => undefined),
  };
  return { session, listeners, calls };
}

function emitTurnEnd(listeners: Array<(e: any) => void>, continues = true) {
  const content = continues
    ? [{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }]
    : [{ type: "text", text: "done" }];
  for (const listener of listeners) {
    listener({
      type: "turn_end",
      message: { role: "assistant", content, stopReason: "stop" },
      toolResults: [],
    });
  }
}

/**
 * Program session.prompt to emit `turns` turn_end events, then settle the run
 * with a final assistant message. The turn count is the meaningful input that
 * drives the steer/abort boundary each turn-limit test asserts on.
 */
function programTurns(
  session: ReturnType<typeof createSession>["session"],
  listeners: ReturnType<typeof createSession>["listeners"],
  turns: number,
  finalText = "done",
) {
  session.prompt = vi.fn(async () => {
    for (let i = 0; i < turns; i++) emitTurnEnd(listeners, i < turns - 1);
    session.messages.push({ role: "assistant", content: [{ type: "text", text: finalText }] });
  });
}

/** Build a SubagentSession around a session stub with default meta. */
function makeSubagentSession(
  session: ReturnType<typeof createSession>["session"],
  metaOverrides?: Partial<{
    outputFile: string | undefined;
    sessionId: string;
    sessionDir: string;
    agentName: string;
    parentContext: string | undefined;
    lifecycle: ReturnType<typeof createChildLifecycleMock>;
    lease: SubagentSessionMeta["lease"];
    checkpointManager: SubagentSessionMeta["checkpointManager"];
  }>,
) {
  const lifecycle = metaOverrides?.lifecycle ?? createChildLifecycleMock();
  const hasOutputFile = metaOverrides != null && "outputFile" in metaOverrides;
  const sub = new SubagentSession(session as unknown as AgentSession, {
    outputFile: hasOutputFile ? metaOverrides.outputFile : "/sessions/child.jsonl",
    sessionId: metaOverrides?.sessionId ?? "child-session-default",
    sessionDir: metaOverrides?.sessionDir ?? "/sessions/dir",
    agentName: metaOverrides?.agentName ?? "Explore",
    parentContext: metaOverrides?.parentContext,
    lease: metaOverrides?.lease,
    checkpointManager: metaOverrides?.checkpointManager,
    lifecycle,
  });
  return { sub, lifecycle };
}

let lifecycle: ReturnType<typeof createChildLifecycleMock>;

beforeEach(() => {
  lifecycle = createChildLifecycleMock();
});

describe("SubagentSession — accessors", () => {
  it("exposes the wrapped session and stable session identity", () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session, {
      outputFile: "/out.jsonl",
      sessionId: "child-stable-id",
    });
    expect(sub.session).toBe(session);
    expect(sub.sessionId).toBe("child-stable-id");
    expect(sub.outputFile).toBe("/out.jsonl");
  });

  it("returns undefined outputFile when none was persisted", () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session, { outputFile: undefined });
    expect(sub.outputFile).toBeUndefined();
  });
});

const DEFAULT_LIMITS = { maxTurns: 30, wrapUpTurns: 2 };

describe("SubagentSession — response capture", () => {
  it("returns the final assistant text even when no text_delta events streamed", async () => {
    const { session } = createSession("LOCKED");
    const { sub } = makeSubagentSession(session);
    const result = await sub.runTurnLoop("Say LOCKED", DEFAULT_LIMITS);
    expect(result).toMatchObject({ responseText: "LOCKED", outcome: "completed" });
  });

  it("captures streamed text_delta events as the response", async () => {
    const { session, listeners } = createSession("FALLBACK");
    session.prompt = vi.fn(async () => {
      for (const listener of listeners) {
        listener({ type: "message_start" });
        listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello " } });
        listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } });
      }
    });
    const { sub } = makeSubagentSession(session);
    const result = await sub.runTurnLoop("go", DEFAULT_LIMITS);
    expect(result.responseText).toBe("hello world");
  });

  it("does not reuse an earlier reply when resume produces no new assistant text", async () => {
    const { session } = createSession("EARLIER");
    const { sub } = makeSubagentSession(session);
    await sub.runTurnLoop("first", DEFAULT_LIMITS);
    session.prompt = vi.fn(async () => {});
    const result = await sub.resumeTurnLoop("second", DEFAULT_LIMITS);
    expect(result).toMatchObject({ responseText: "", outcome: "completed" });
  });

  it("reports a final model error even when prompt resolves normally", async () => {
    const { session } = createSession("old reply");
    session.prompt = vi.fn(async () => {
      session.messages.push({ role: "assistant", content: [], stopReason: "error", errorMessage: "rate limit exhausted" });
    });
    const { sub } = makeSubagentSession(session);
    await expect(sub.runTurnLoop("go", DEFAULT_LIMITS)).rejects.toThrow("rate limit exhausted");
  });

  it("uses the successful retry instead of the earlier error", async () => {
    const { session, listeners } = createSession("unused");
    session.prompt = vi.fn(async () => {
      const error = { role: "assistant", content: [], stopReason: "error", errorMessage: "transient" };
      const success = { role: "assistant", content: [{ type: "text", text: "retried" }], stopReason: "stop" };
      for (const message of [error, success]) {
        session.messages.push(message);
        for (const listener of listeners) listener({ type: "message_end", message });
      }
    });
    const { sub } = makeSubagentSession(session);
    await expect(sub.runTurnLoop("go", DEFAULT_LIMITS)).resolves.toMatchObject({ responseText: "retried", outcome: "completed" });
  });

  it("keeps a legitimate empty final answer empty after a tool turn", async () => {
    const { session } = createSession("unused");
    session.prompt = vi.fn(async () => {
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "working" }], stopReason: "toolUse" });
      session.messages.push({ role: "assistant", content: [], stopReason: "stop" });
    });
    const { sub } = makeSubagentSession(session);
    await expect(sub.runTurnLoop("go", DEFAULT_LIMITS)).resolves.toMatchObject({ responseText: "", outcome: "completed" });
  });

  it("does not start a prompt after its signal was already cancelled", async () => {
    const { session } = createSession("unused");
    const { sub } = makeSubagentSession(session);
    const controller = new AbortController();
    controller.abort();
    await expect(sub.runTurnLoop("go", { ...DEFAULT_LIMITS, signal: controller.signal })).resolves.toMatchObject({ outcome: "cancelled" });
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("classifies a final aborted model response as cancelled", async () => {
    const { session } = createSession("unused");
    session.prompt = vi.fn(async () => {
      session.messages.push({ role: "assistant", content: [], stopReason: "aborted" });
    });
    const { sub } = makeSubagentSession(session);
    await expect(sub.runTurnLoop("go", DEFAULT_LIMITS)).resolves.toMatchObject({ outcome: "cancelled" });
  });

  it("prepends parentContext only to the fresh prompt", async () => {
    const { session } = createSession("DONE");
    const { sub } = makeSubagentSession(session, { parentContext: "CTX\n" });
    await sub.runTurnLoop("the task", DEFAULT_LIMITS);
    await sub.resumeTurnLoop("continue", DEFAULT_LIMITS);
    expect(session.prompt).toHaveBeenNthCalledWith(1, "CTX\nthe task");
    expect(session.prompt).toHaveBeenNthCalledWith(2, "continue");
  });
});

describe("SubagentSession — strict turn limits", () => {
  it("reserves wrap-up turns inside the hard maximum", async () => {
    const { session, listeners } = createSession("done");
    programTurns(session, listeners, 4);
    const { sub } = makeSubagentSession(session);
    const result = await sub.runTurnLoop("go", { maxTurns: 4, wrapUpTurns: 2 });
    expect(session.steer).toHaveBeenCalledOnce();
    expect(session.abort).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "completed", wrappedUp: true });
  });

  it("classifies a run that still needs another model call at the hard limit", async () => {
    const { session, listeners } = createSession("partial");
    session.prompt = vi.fn(async () => {
      emitTurnEnd(listeners, true);
      emitTurnEnd(listeners, true);
    });
    const { sub } = makeSubagentSession(session);
    const result = await sub.runTurnLoop("go", { maxTurns: 2, wrapUpTurns: 1 });
    expect(session.abort).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("turn_limit");
  });

  it("does not force a wrap-up turn after a natural final answer", async () => {
    const { session, listeners } = createSession("done");
    session.prompt = vi.fn(async () => emitTurnEnd(listeners, false));
    const { sub } = makeSubagentSession(session);
    const result = await sub.runTurnLoop("go", { maxTurns: 3, wrapUpTurns: 2 });
    expect(session.steer).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(result.outcome).toBe("completed");
  });

  it("applies the same hard limit to resume", async () => {
    const { session, listeners } = createSession("partial");
    session.prompt = vi.fn(async () => emitTurnEnd(listeners, true));
    const { sub } = makeSubagentSession(session);
    const result = await sub.resumeTurnLoop("Continue", { maxTurns: 1, wrapUpTurns: 0 });
    expect(session.abort).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("turn_limit");
  });
});

describe("SubagentSession — abort signal", () => {
  it("aborts the session and reports cancellation", async () => {
    const controller = new AbortController();
    const { session } = createSession("X");
    session.prompt = vi.fn(() => new Promise<void>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(), { once: true });
    }));
    const { sub } = makeSubagentSession(session);
    const promise = sub.runTurnLoop("go", { ...DEFAULT_LIMITS, signal: controller.signal });
    controller.abort();
    const result = await promise;
    expect(session.abort).toHaveBeenCalled();
    expect(result.outcome).toBe("cancelled");
  });

  it("does not abort when the signal remains active", async () => {
    const controller = new AbortController();
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session);
    await sub.runTurnLoop("go", { ...DEFAULT_LIMITS, signal: controller.signal });
    expect(session.abort).not.toHaveBeenCalled();
  });
});

describe("SubagentSession — child lifecycle", () => {
  it("emits the classified fresh outcome", async () => {
    const { session } = createSession("OK");
    const { sub } = makeSubagentSession(session, { sessionDir: "/d", agentName: "Explore", lifecycle });
    await sub.runTurnLoop("go", DEFAULT_LIMITS);
    expect(lifecycle.completed).toHaveBeenCalledExactlyOnceWith({
      sessionDir: "/d",
      agentName: "Explore",
      outcome: "completed",
      wrappedUp: false,
    });
  });

  it("does not emit completed or disposed for resume", async () => {
    const { session } = createSession("RESUMED");
    const { sub } = makeSubagentSession(session, { lifecycle });
    await sub.resumeTurnLoop("Continue", DEFAULT_LIMITS);
    expect(lifecycle.completed).not.toHaveBeenCalled();
    expect(lifecycle.disposed).not.toHaveBeenCalled();
  });

  it("skips completed when prompt throws", async () => {
    const { session } = createSession("OK");
    session.prompt = vi.fn().mockRejectedValue(new Error("prompt failed"));
    const { sub } = makeSubagentSession(session, { lifecycle });
    await expect(sub.runTurnLoop("go", DEFAULT_LIMITS)).rejects.toThrow("prompt failed");
    expect(lifecycle.completed).not.toHaveBeenCalled();
  });
});

describe("SubagentSession — steer", () => {
  it("delegates the message to the live session", async () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session);
    await sub.steer("hurry up");
    expect(session.steer).toHaveBeenCalledWith("hurry up");
  });
});

describe("SubagentSession — delegate methods", () => {
  it("getConversation returns formatted text from session messages", () => {
    const { session } = createSession("X");
    session.messages.push({ role: "user", content: "Hello" });
    session.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "World" }],
    });
    const { sub } = makeSubagentSession(session);
    const conv = sub.getConversation();
    expect(conv).toContain("[User]: Hello");
    expect(conv).toContain("[Assistant");
    expect(conv).toContain("World");
  });

  it("getContextPercent returns the session context percent", () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session);
    expect(sub.getContextPercent()).toBe(42);
  });

  it("getContextPercent returns null when getSessionStats is unavailable", () => {
    const { session } = createSession("X");
    session.getSessionStats = vi.fn(() => { throw new Error("no stats"); });
    const { sub } = makeSubagentSession(session);
    expect(sub.getContextPercent()).toBeNull();
  });

  it("subscribe delegates to the underlying session", () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session);
    const fn = vi.fn();
    const unsub = sub.subscribe(fn);
    expect(session.subscribe).toHaveBeenCalledWith(fn);
    expect(typeof unsub).toBe("function");
  });

  it("getSessionStats delegates to the underlying session", () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session);
    const stats = sub.getSessionStats();
    expect(session.getSessionStats).toHaveBeenCalled();
    expect(stats.tokens.input).toBe(100);
  });

  it("messages returns the underlying session messages", () => {
    const { session } = createSession("X");
    session.messages.push({ role: "user", content: "hi" });
    const { sub } = makeSubagentSession(session);
    expect(sub.messages).toBe(session.messages);
  });

  it("agentMessages returns the underlying session messages typed", () => {
    const { session } = createSession("X");
    session.messages.push({ role: "user", content: "hi" });
    const { sub } = makeSubagentSession(session);
    expect(sub.agentMessages).toBe(session.messages);
  });

  it("getToolDefinition delegates to the underlying session", () => {
    const { session } = createSession("X");
    const def = { name: "read" };
    session.getToolDefinition = vi.fn(() => def);
    const { sub } = makeSubagentSession(session);
    expect(sub.getToolDefinition("read")).toBe(def);
    expect(session.getToolDefinition).toHaveBeenCalledWith("read");
  });
});

describe("SubagentSession — persisted close boundary", () => {
  function leasedSession() {
    const { session, calls } = createSession("X");
    const release = vi.fn(() => { calls.push("release"); });
    const appendCustomEntry = vi.fn((_type: string, _data: unknown) => { calls.push("checkpoint"); return "close-entry"; });
    const checkpointManager = {
      getSessionId: () => "child-session-default", getSessionFile: () => "/sessions/child.jsonl",
      getCwd: () => "/project", getLeafId: () => "boundary", appendCustomEntry,
    };
    const { sub } = makeSubagentSession(session, { lease: { path: "/lease", token: "owner", release }, checkpointManager });
    const receipt = { parentId: "parent", parentFile: "/parent.jsonl", terminalEntryId: "terminal",
      agentId: "agent", agentType: "Explore", childSessionId: "child-session-default", invocationIndex: 1,
      isCurrent: () => true };
    return { session, calls, sub, release, appendCustomEntry, receipt };
  }

  it("writes the private checkpoint after disposal, then releases ownership", async () => {
    const { sub, calls, receipt, appendCustomEntry } = leasedSession();
    await expect(sub.closeForRecovery(receipt)).resolves.toBe(true);
    expect(calls).toEqual(["emit", "dispose", "checkpoint", "release"]);
    expect(appendCustomEntry).toHaveBeenCalledWith("subagents:closed-private", expect.objectContaining({ terminalEntryId: "terminal", boundaryId: "boundary" }));
    expect(appendCustomEntry.mock.calls[0][1]).not.toHaveProperty("isCurrent");
  });

  it("keeps ownership without a persisted parent terminal receipt", async () => {
    const { sub, release, appendCustomEntry } = leasedSession();
    await expect(sub.closeForRecovery(undefined)).resolves.toBe(false);
    expect(release).not.toHaveBeenCalled();
    expect(appendCustomEntry).not.toHaveBeenCalled();
  });

  it("keeps ownership when shutdown has not been confirmed", async () => {
    const { sub, session, receipt, release, appendCustomEntry } = leasedSession();
    session.extensionRunner.emit = vi.fn(async () => { throw new Error("shutdown failed"); });
    await expect(sub.closeForRecovery(receipt)).resolves.toBe(false);
    expect(release).not.toHaveBeenCalled();
    expect(appendCustomEntry).not.toHaveBeenCalled();
  });

  it("keeps ownership if the parent branch changed", async () => {
    const { sub, receipt, release, appendCustomEntry } = leasedSession();
    await expect(sub.closeForRecovery({ ...receipt, isCurrent: () => false })).rejects.toThrow("identity changed");
    expect(release).not.toHaveBeenCalled();
    expect(appendCustomEntry).not.toHaveBeenCalled();
  });

  it("keeps ownership when checkpoint persistence fails", async () => {
    const { sub, receipt, release, appendCustomEntry } = leasedSession();
    appendCustomEntry.mockImplementation(() => { throw new Error("disk full"); });
    await expect(sub.closeForRecovery(receipt)).rejects.toThrow("disk full");
    expect(release).not.toHaveBeenCalled();
  });
});

describe("SubagentSession — dispose", () => {
  it("disposes the session and emits disposed with the child session id", async () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session, { sessionId: "child-session-abc", lifecycle });
    await sub.dispose();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(lifecycle.disposed).toHaveBeenCalledOnce();
    expect(lifecycle.disposed).toHaveBeenCalledWith({ sessionId: "child-session-abc" });
  });

  it("emits session_shutdown to the child's extensions before disposing the session", async () => {
    const { session, calls } = createSession("X");
    const { sub } = makeSubagentSession(session);
    await sub.dispose();
    expect(session.extensionRunner.emit).toHaveBeenCalledWith({
      type: "session_shutdown",
      reason: "quit",
    });
    expect(calls).toEqual(["emit", "dispose"]);
  });

  it("unregisters the child only after its shutdown handlers have run", async () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session, { lifecycle });
    session.extensionRunner.emit = vi.fn((_event: unknown): Promise<unknown> => {
      expect(lifecycle.disposed).not.toHaveBeenCalled();
      return Promise.resolve(undefined);
    });
    await sub.dispose();
    expect(lifecycle.disposed).toHaveBeenCalledOnce();
  });

  it("disposes a child whose extensions registered no shutdown handler", async () => {
    const { session, calls } = createSession("X");
    session.hasExtensionHandlers = vi.fn((_eventType: string): boolean => false);
    const { sub } = makeSubagentSession(session, { lifecycle });
    await sub.dispose();
    expect(session.extensionRunner.emit).not.toHaveBeenCalled();
    expect(calls).toEqual(["dispose"]);
    expect(lifecycle.disposed).toHaveBeenCalledOnce();
  });

  it("is idempotent: a second dispose neither re-emits nor re-disposes", async () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session, { lifecycle });
    await sub.dispose();
    await sub.dispose();
    expect(session.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(lifecycle.disposed).toHaveBeenCalledOnce();
  });

  it("only confirms cleanup after successful shutdown", async () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session);
    expect(sub.cleanupConfirmed).toBe(false);
    await sub.dispose();
    expect(sub.cleanupConfirmed).toBe(true);
  });

  it("does not confirm cleanup after a failed handler", async () => {
    const { session } = createSession("X");
    session.extensionRunner.emit = vi.fn(async () => { throw new Error("shutdown failed"); });
    const { sub } = makeSubagentSession(session);
    await sub.dispose();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(sub.cleanupConfirmed).toBe(false);
  });

  it("all concurrent disposal callers wait for the same teardown", async () => {
    const { session } = createSession("X");
    let finish!: () => void;
    session.extensionRunner.emit = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { sub } = makeSubagentSession(session);
    const first = sub.dispose();
    const second = sub.dispose();
    expect(second).toBe(first);
    expect(sub.cleanupConfirmed).toBe(false);
    finish();
    await second;
    expect(sub.cleanupConfirmed).toBe(true);
  });

  it("guards re-entry before its first await, so concurrent disposes emit once", async () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session, { lifecycle });
    await Promise.all([sub.dispose(), sub.dispose()]);
    expect(session.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });
});
