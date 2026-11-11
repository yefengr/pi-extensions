import type { AgentSession, BuildSystemPromptOptions, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentSession } from "#src/lifecycle/create-subagent-session";
import { SubagentSession } from "#src/lifecycle/subagent-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import {
  createAgentLookup,
  createChildLifecycleMock,
  createFactorySession,
  createSubagentSessionDeps,
  createSubagentSessionIO,
} from "#test/helpers/subagent-session-io";

/** Mock AgentConfigLookup. */
const mockAgentLookup = createAgentLookup();

let io: ReturnType<typeof createSubagentSessionIO>;

const exec = vi.fn();

beforeEach(() => {
  io = createSubagentSessionIO();
});

/** Arrange: build a factory session and wire it as the created session. Returns it for assertions. */
function arrangeFactory() {
  const session = createFactorySession();
  io.createSession.mockResolvedValue({ session });
  return session;
}

/** The standard deps bag for the default `io`/`exec`/`registry` wiring. */
function defaultDeps() {
  return createSubagentSessionDeps({ io, exec, registry: mockAgentLookup });
}

describe("createSubagentSession — assembly", () => {
  let session: ReturnType<typeof createFactorySession>;

  beforeEach(() => {
    session = createFactorySession();
    io.createSession.mockResolvedValue({ session });
  });

  it("normalizes declared aliases before SDK admission", async () => {
    const registry = { ...mockAgentLookup, getToolNamesForType: () => ["Read", "Shell", "Glob"] };
    await createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry }));
    expect(io.createSession).toHaveBeenCalledWith(expect.objectContaining({ tools: ["read", "bash", "find"] }));
  });

  it("returns a born-complete SubagentSession wrapping the created session", async () => {
    const sub = await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(sub).toBeInstanceOf(SubagentSession);
    expect(sub.session).toBe(session);
  });

  it("exposes stable session identity and the persisted outputFile", async () => {
    const sub = await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(sub.sessionId).toBe("child-session-id");
    expect(sub.outputFile).toBe("/sessions/child.jsonl");
  });

  it("captures stable identity before extension binding", async () => {
    const onSessionCreated = vi.fn();

    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "Explore", onSessionCreated },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(onSessionCreated).toHaveBeenCalledExactlyOnceWith({
      sessionId: "child-session-id",
      outputFile: "/sessions/child.jsonl",
    });
    expect(onSessionCreated.mock.invocationCallOrder[0]).toBeLessThan(
      session.bindExtensions.mock.invocationCallOrder[0],
    );
  });

  it("binds extensions before returning", async () => {
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(session.bindExtensions).toHaveBeenCalledTimes(1);
    expect(session.bindExtensions).toHaveBeenCalledWith({});
  });

  it("passes the effective cwd and agentDir to the loader, settings, and session", async () => {
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "Explore", cwd: "/tmp/worktree" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(io.getAgentDir).toHaveBeenCalledTimes(1);
    expect(io.createResourceLoader).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/worktree", agentDir: "/mock/agent-dir" }),
    );
    expect(io.createSettingsManager).toHaveBeenCalledWith("/tmp/worktree", "/mock/agent-dir", false);
    expect(io.createSessionManager).toHaveBeenCalledWith("/tmp/worktree", "/mock/session-dir/tasks");
    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/worktree", agentDir: "/mock/agent-dir" }),
    );
  });

  it("gives the resource loader the derived settings view, not the session's own", async () => {
    const sessionSettings = { marker: "session" };
    const loaderSettings = { marker: "loader" };
    io.createSettingsManager.mockReturnValue(sessionSettings);
    io.createLoaderSettingsManager.mockReturnValue(loaderSettings);

    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(io.createLoaderSettingsManager).toHaveBeenCalledWith(sessionSettings);
    expect(io.createResourceLoader).toHaveBeenCalledWith(
      expect.objectContaining({ settingsManager: loaderSettings }),
    );
    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ settingsManager: sessionSettings }),
    );
  });

  it("inherits same-directory trust and uses only the target's existing decision across cwd", async () => {
    Object.assign(session, { agent: { transformContext: undefined } });
    for (const [cwd, trusted] of [[STUB_SNAPSHOT.cwd, true], ["/different-worktree", false], ["/approved-worktree", true]] as const) {
      io.createSettingsManager.mockClear();
      const snapshot = { ...STUB_SNAPSHOT, projectTrusted: true, promptOptions: { cwd: STUB_SNAPSHOT.cwd } };
      const getProjectTrust = vi.fn(() => trusted);
      const deps = { ...defaultDeps(), io: { ...io, getProjectTrust } };
      await createSubagentSession({ snapshot, type: "Explore", cwd }, deps);
      expect(io.createSettingsManager).toHaveBeenCalledWith(cwd, "/mock/agent-dir", trusted);
      expect(getProjectTrust).toHaveBeenCalledTimes(cwd === STUB_SNAPSHOT.cwd ? 0 : 1);
      const options = io.createResourceLoader.mock.lastCall?.[0];
      expect(options.noContextFiles).toBe(false);
      expect(options.appendSystemPromptOverride(["target rules"])).toEqual(["target rules"]);
    }
  });

  it("wraps the SDK transform once, awaits it with its signal, and rebinds on reload", async () => {
    const signal = new AbortController().signal;
    const transformed: AgentSession["messages"] = [{ role: "system", content: "", sections: {
      subagent_identity: "old identity", agent_browser: "stale browser", operator: "keep operator",
    }, toolsAdded: [], timestamp: 0 }];
    const original = vi.fn(async () => transformed);
    const agent = { transformContext: original as AgentSession["agent"]["transformContext"] };
    Object.assign(session, {
      agent, getCallableToolNames: () => [], getActiveToolNames: () => [],
    });
    await createSubagentSession({
      snapshot: { ...STUB_SNAPSHOT, promptOptions: { cwd: STUB_SNAPSHOT.cwd, sections: { agent_browser: "parent browser" } } },
      type: "Explore",
    }, defaultDeps());
    const factory = io.createResourceLoader.mock.lastCall?.[0].extensionFactories.at(-1) as ExtensionFactory;
    let handler: ((event: { systemPromptOptions: BuildSystemPromptOptions }) => void) | undefined;
    const load = (body: string) => {
      factory({
        on: (_event: string, next: typeof handler) => { handler = next; }, getAllTools: () => [],
      } as unknown as Parameters<ExtensionFactory>[0]);
      handler?.({ systemPromptOptions: { cwd: STUB_SNAPSHOT.cwd, selectedTools: [], sections: { agent_browser: body } } });
    };
    load("first body");
    const wrapper = agent.transformContext;
    const input: AgentSession["messages"] = [{ role: "user", content: "user text", timestamp: 1 }];
    const before = structuredClone(transformed);
    const first = await wrapper?.(input, signal);
    expect(original).toHaveBeenCalledExactlyOnceWith(input, signal);
    expect(first?.[0]).toMatchObject({ sections: { operator: "keep operator", subagent_identity: expect.stringContaining("none.") } });
    expect(transformed).toEqual(before);
    Object.assign(session, { getCallableToolNames: () => ["agent_browser_preview"] });
    load("reloaded body");
    const second = await agent.transformContext?.(input, signal);
    expect(agent.transformContext).toBe(wrapper);
    expect(second?.[0]).toMatchObject({ sections: { agent_browser: "<agent_browser>\nreloaded body\n</agent_browser>" } });
  });

  it("keeps the SDK transform untouched on the legacy unstructured path", async () => {
    const original = vi.fn();
    const agent = { transformContext: original };
    Object.assign(session, { agent });
    await createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "Explore" }, defaultDeps());
    expect(agent.transformContext).toBe(original);
  });

  it("rejects unverified cross-directory APPEND scope before creating an SDK session", async () => {
    const snapshot = { ...STUB_SNAPSHOT, promptOptions: { cwd: STUB_SNAPSHOT.cwd, appendSystemPrompt: "parent project rules" } };
    await expect(createSubagentSession({ snapshot, type: "Explore", cwd: "/target" }, defaultDeps()))
      .rejects.toThrow("verified source metadata");
    expect(io.createSession).not.toHaveBeenCalled();
  });

  it("releases ownership when pre-extension environment discovery fails", async () => {
    const lease = { path: "/tasks/.child-lease", token: "owner", release: vi.fn() };
    io.detectEnv.mockRejectedValueOnce(new Error("environment failed"));
    const deps = { ...defaultDeps(), io: { ...io, acquireSessionLease: () => lease } };
    await expect(createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "Explore" }, deps)).rejects.toThrow("environment failed");
    expect(lease.release).toHaveBeenCalledOnce();
    expect(io.createSession).not.toHaveBeenCalled();
  });

  it("releases the existing recovery lease after pre-extension failure without creating a session", async () => {
    const lease = { path: "/tasks/.existing-lease", token: "owner", release: vi.fn() };
    const manager = io.createSessionManager("/original", "/tasks");
    io.createSessionManager.mockClear();
    io.detectEnv.mockRejectedValueOnce(new Error("recovery environment failed"));
    await expect(createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "Explore", recovery: { manager, lease } }, defaultDeps()))
      .rejects.toThrow("recovery environment failed");
    expect(lease.release).toHaveBeenCalledOnce();
    expect(io.createSessionManager).not.toHaveBeenCalled();
    expect(manager.newSession).not.toHaveBeenCalled();
    expect(io.createSession).not.toHaveBeenCalled();
  });

  it("preserves the initialization cause and marker path when ownership release fails", async () => {
    const cause = new Error("environment failed");
    const releaseError = new Error("owner changed");
    const lease = { path: "/tasks/.child-lease", token: "owner", release: vi.fn(() => { throw releaseError; }) };
    io.detectEnv.mockRejectedValueOnce(cause);
    const deps = { ...defaultDeps(), io: { ...io, acquireSessionLease: () => lease } };
    await expect(createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "Explore" }, deps))
      .rejects.toMatchObject({ message: expect.stringContaining(lease.path), errors: [cause, releaseError] });
  });

  it("hands confirmed bind-failure cleanup back to the invocation owner", async () => {
    const lease = { path: "/tasks/.child-lease", token: "owner", release: vi.fn() };
    const session = createFactorySession();
    session.bindExtensions.mockRejectedValueOnce(new Error("bind failed"));
    io.createSession.mockResolvedValueOnce({ session });
    const failed = vi.fn();
    const deps = { ...defaultDeps(), io: { ...io, acquireSessionLease: () => lease } };
    await expect(createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "Explore", onInitializationFailed: failed }, deps))
      .rejects.toThrow("bind failed");
    expect(failed).toHaveBeenCalledOnce();
    expect(failed.mock.calls[0][0].cleanupConfirmed).toBe(true);
    expect(lease.release).not.toHaveBeenCalled(); // The parent terminal must still be persisted first.
  });

  it("exposes retained ownership when SDK initialization cleanup cannot be confirmed", async () => {
    const lease = { path: "/tasks/.child-lease", token: "owner", release: vi.fn() };
    io.createSession.mockRejectedValueOnce(new Error("SDK initialization failed"));
    const deps = { ...defaultDeps(), io: { ...io, acquireSessionLease: () => lease } };
    await expect(createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "Explore" }, deps)).rejects.toThrow(lease.path);
    expect(lease.release).not.toHaveBeenCalled();
  });

  it("activates only declared registered names and rejects missing or excess callable tools", async () => {
    const sessionWithTools = Object.assign(createFactorySession(), {
      getAllTools: vi.fn(() => [{ name: "read" }, { name: "subagent" }, { name: "write" }]),
      getCallableToolNames: vi.fn(() => ["read"]),
    });
    io.createSession.mockResolvedValue({ session: sessionWithTools });
    await createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "Explore" }, defaultDeps());
    expect(sessionWithTools.setActiveToolsByName).toHaveBeenCalledExactlyOnceWith(["read"]);
    sessionWithTools.getCallableToolNames.mockReturnValueOnce(["read", "write"]);
    await expect(createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "Explore" }, defaultDeps()))
      .rejects.toThrow("exceed the declared allowlist");
    sessionWithTools.getAllTools.mockReturnValueOnce([{ name: "write" }]);
    await expect(createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "Explore" }, defaultDeps()))
      .rejects.toThrow("unavailable after extension binding");
  });

  it("rejects opaque or missing production prompt state before creating SDK objects", async () => {
    await expect(createSubagentSession({ snapshot: { ...STUB_SNAPSHOT, projectTrusted: false }, type: "Explore" }, defaultDeps()))
      .rejects.toThrow("structured system prompt");
    await expect(createSubagentSession({ snapshot: { ...STUB_SNAPSHOT, promptOptions: { cwd: "/tmp", forceSystemPrompt: "" } }, type: "Explore" }, defaultDeps()))
      .rejects.toThrow("opaque forceSystemPrompt");
    expect(io.createSession).not.toHaveBeenCalled();
  });

  it("creates the session's settings manager exactly once and reuses it", async () => {
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(io.createSettingsManager).toHaveBeenCalledTimes(1);
    expect(io.createLoaderSettingsManager).toHaveBeenCalledTimes(1);
  });

  it("suppresses AGENTS.md/CLAUDE.md/APPEND_SYSTEM.md for subagents", async () => {
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(io.createResourceLoader).toHaveBeenCalledWith(
      expect.objectContaining({
        noContextFiles: true,
        appendSystemPromptOverride: expect.any(Function),
      }),
    );
    const loaderOpts = io.createResourceLoader.mock.calls[0][0];
    expect(loaderOpts.appendSystemPromptOverride()).toEqual([]);
  });

  it("calls newSession with parentSession when parentSessionId is provided", async () => {
    await createSubagentSession(
      {
        snapshot: STUB_SNAPSHOT,
        type: "Explore",
        parentSession: { parentSessionFile: "/sessions/parent.jsonl", parentSessionId: "parent-id-123" },
      },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    const sm = io.createSessionManager.mock.results[0].value;
    expect(sm.newSession).toHaveBeenCalledWith({ parentSession: "parent-id-123" });
  });
});

describe("createSubagentSession — lifecycle ordering", () => {
  let session: ReturnType<typeof createFactorySession>;
  let lifecycle: ReturnType<typeof createChildLifecycleMock>;

  beforeEach(() => {
    session = createFactorySession();
    io.createSession.mockResolvedValue({ session });
    lifecycle = createChildLifecycleMock();
  });

  it("emits spawning before session-created", async () => {
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
    );

    expect(lifecycle.spawning).toHaveBeenCalledOnce();
    const spawnOrder = lifecycle.spawning.mock.invocationCallOrder[0];
    const createdOrder = lifecycle.sessionCreated.mock.invocationCallOrder[0];
    expect(spawnOrder).toBeLessThan(createdOrder);
  });

  it("emits session-created before bindExtensions()", async () => {
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
    );

    expect(lifecycle.sessionCreated).toHaveBeenCalledOnce();
    const createdOrder = lifecycle.sessionCreated.mock.invocationCallOrder[0];
    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    expect(createdOrder).toBeLessThan(bindOrder);
  });

  it("carries the session id and parent session id in session-created", async () => {
    io.deriveSessionDir.mockReturnValue("/custom/session/dir");

    await createSubagentSession(
      {
        snapshot: STUB_SNAPSHOT,
        type: "Explore",
        parentSession: {
          parentSessionFile: "/sessions/parent.jsonl",
          parentSessionId: "parent-session-42",
        },
      },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
    );

    expect(lifecycle.sessionCreated).toHaveBeenCalledWith({
      sessionId: "child-session-id",
      parentSessionId: "parent-session-42",
    });
  });

  it("does not emit completed or disposed during creation", async () => {
    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "Explore" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
    );

    expect(lifecycle.completed).not.toHaveBeenCalled();
    expect(lifecycle.disposed).not.toHaveBeenCalled();
  });
});

describe("createSubagentSession — dispose on creation failure", () => {
  it("captures identity and disposes when bindExtensions throws, then rethrows", async () => {
    const session = createFactorySession();
    session.bindExtensions = vi.fn().mockRejectedValue(new Error("bind failed"));
    io.createSession.mockResolvedValue({ session });
    io.deriveSessionDir.mockReturnValue("/custom/session/dir");
    const lifecycle = createChildLifecycleMock();
    const onSessionCreated = vi.fn();

    await expect(
      createSubagentSession(
        { snapshot: STUB_SNAPSHOT, type: "Explore", onSessionCreated },
        createSubagentSessionDeps({ io, exec, registry: mockAgentLookup, lifecycle }),
      ),
    ).rejects.toThrow("bind failed");

    expect(onSessionCreated).toHaveBeenCalledExactlyOnceWith({
      sessionId: "child-session-id",
      outputFile: "/sessions/child.jsonl",
    });
    // session-created fired, so disposed must fire to avoid a registry leak.
    expect(lifecycle.sessionCreated).toHaveBeenCalledOnce();
    expect(lifecycle.disposed).toHaveBeenCalledOnce();
    expect(lifecycle.disposed).toHaveBeenCalledWith({ sessionId: "child-session-id" });
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("shuts down the extensions that did initialize before the bind failed", async () => {
    const session = createFactorySession();
    session.bindExtensions = vi.fn().mockRejectedValue(new Error("bind failed"));
    io.createSession.mockResolvedValue({ session });

    await expect(
      createSubagentSession(
        { snapshot: STUB_SNAPSHOT, type: "Explore" },
        createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
      ),
    ).rejects.toThrow("bind failed");

    expect(session.extensionRunner.emit).toHaveBeenCalledWith({
      type: "session_shutdown",
      reason: "quit",
    });
  });
});

describe("createSubagentSession — recursion guard", () => {
  // A child loads this extension too, so it registers the spawn tools during
  // bindExtensions. They are denied at the SDK boundary, which holds for the
  // child's whole life — a post-bind active-set filter would be undone by the
  // next tool-registry refresh (#725).

  it("denies this extension's spawn tools when creating the child session", async () => {
    arrangeFactory();

    await createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "Explore" }, defaultDeps());

    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeTools: ["subagent", "get_subagent_result", "steer_subagent"],
      }),
    );
  });

  it("leaves the child's active tool set untouched after bind", async () => {
    const session = arrangeFactory();

    await createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "Explore" }, defaultDeps());

    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
  });
});
