import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#src/lifecycle/create-subagent-session", async () => {
  const actual = await vi.importActual<typeof import("#src/lifecycle/create-subagent-session")>(
    "#src/lifecycle/create-subagent-session",
  );
  return {
    ...actual,
    createSubagentSession: vi.fn(),
  };
});

import subagentsExtension from "#src/index";
import { createSubagentSession } from "#src/lifecycle/create-subagent-session";
import { createMockSession, createSubagentSessionStub, toSubagentSession } from "./helpers/mock-session";

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const eventHandlers = new Map<string, any>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          eventHandlers.set(event, handler);
          return vi.fn();
        }),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(() => {
        throw new Error("stale extension context");
      }),
    } as any,
    tools,
    handlers,
  };
}

function makeHeadlessCtx() {
  return {
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: {
      find: vi.fn(),
      getAvailable: vi.fn(() => []),
    },
    sessionManager: {
      getSessionId: vi.fn(() => "session-1"),
      getSessionFile: vi.fn(() => "/sessions/parent.jsonl"),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
  } as any;
}

describe("print mode background notifications", () => {
  let isolatedAgentDir: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    if (isolatedAgentDir) rmSync(isolatedAgentDir, { recursive: true, force: true });
    isolatedAgentDir = undefined;
  });

  it("ignores stale-context errors from delayed completion nudges", async () => {
    // Do not inherit a user's global agent definitions: they may disable or
    // override the built-in general-purpose type the test deliberately uses.
    isolatedAgentDir = mkdtempSync(join(tmpdir(), "subagents-print-mode-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", isolatedAgentDir);
    vi.mocked(createSubagentSession).mockResolvedValue(
      toSubagentSession(createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl")),
    );

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    // Fire session_start so runtime.currentCtx is populated for buildSnapshot
    const ctx = makeHeadlessCtx();
    await handlers.get("session_start")?.({}, ctx);
    handlers.get("agent_start")?.({}, ctx);

    const agentTool = tools.get("subagent");
    const launch = await agentTool.execute(
      "tool-call-1",
      {
        prompt: "reply done",
        description: "tiny child",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      undefined,
      undefined,
      makeHeadlessCtx(),
    );

    expect(launch.content[0]?.text).toContain("Agent started in background.");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100); // allow the scheduled background run to settle
    handlers.get("agent_settled")?.({}, ctx);

    expect(createSubagentSession).toHaveBeenCalled();
    expect(pi.events.emit).toHaveBeenCalledWith("subagent:completed", expect.anything());
    expect(pi.sendMessage).toHaveBeenCalled();

    await handlers.get("session_shutdown")?.({}, makeHeadlessCtx());
  });
});
