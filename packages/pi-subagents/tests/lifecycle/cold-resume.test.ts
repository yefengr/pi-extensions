import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { AgentSession, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionLifecycleHandler } from "#src/handlers/lifecycle";
import { type ColdResumeIO, recoverSubagent } from "#src/lifecycle/cold-resume";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import { type CreateSubagentSessionParams, createSubagentSession, type SubagentSessionDeps } from "#src/lifecycle/create-subagent-session";
import { type AgentSpawnConfig, SubagentManager } from "#src/lifecycle/subagent-manager";
import { SubagentSession } from "#src/lifecycle/subagent-session";
import { PersistedSubagentStore } from "#src/session/persisted-records";
import { validateRecoveryTranscript } from "#src/session/recovery-checkpoint";
import { acquireSessionLease } from "#src/session/session-lease";
import { makeModel } from "#test/helpers/make-model";
import { createMockSession, createSubagentSessionStub, toSubagentSession } from "#test/helpers/mock-session";
import { assistantMessage, createRecoveryFixture, persistTerminal } from "#test/helpers/recovery-fixture";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import { createAgentLookup, createChildLifecycleMock, createSubagentSessionIO } from "#test/helpers/subagent-session-io";

let fixture: ReturnType<typeof createRecoveryFixture>;
const managers: SubagentManager[] = [];
beforeEach(() => { fixture = createRecoveryFixture(); });
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  vi.restoreAllMocks();
  fixture.cleanup();
});

function arrange() {
  const mock = createMockSession();
  const session = createSubagentSessionStub(mock, fixture.file, fixture.child.getSessionId());
  const createSession = vi.fn(async (_params: CreateSubagentSessionParams) => toSubagentSession(session));
  const io = {
    store: fixture.store, isEnabled: vi.fn(() => true),
    acquireLease: vi.fn(acquireSessionLease), open: vi.fn((file: string) => SessionManager.open(file)),
  } satisfies ColdResumeIO;
  const config: AgentSpawnConfig = { description: "resume", maxTurns: 4, wrapUpTurns: 1, maxDurationSeconds: 30,
    parentSession: { parentSessionId: fixture.parent.getSessionId(), parentSessionFile: fixture.parentFile } };
  const snapshot = { ...STUB_SNAPSHOT, cwd: fixture.cwd, parentContext: "must not duplicate parent context" };
  const manager = new SubagentManager({ coldResume: io, createSubagentSession: createSession,
    limiter: new ConcurrencyLimiter(() => 1), baseCwd: fixture.cwd });
  managers.push(manager);
  return { mock, session, createSession, io, config, snapshot, manager };
}

function assertUntouched(before: string, parentBefore: string, setup: ReturnType<typeof arrange>) {
  expect(fixture.text()).toBe(before);
  expect(readFileSync(fixture.parentFile, "utf8")).toBe(parentBefore);
  expect(setup.io.open).not.toHaveBeenCalled();
  expect(setup.createSession).not.toHaveBeenCalled();
  expect(setup.manager.listAgents()).toEqual([]);
}

describe("cold resume coordination", () => {
  it("retains identity, index and lifetime seed; resets only the next invocation", async () => {
    const setup = arrange();
    const agent = await setup.manager.restore(fixture.record.id, setup.snapshot, setup.config);
    expect(agent.id).toBe(fixture.record.id);
    expect(agent.type).toBe(fixture.record.type);
    expect(agent.sessionId).toBe(fixture.child.getSessionId());
    expect(agent.outputFile).toBe(fixture.file);
    expect(agent.invocationIndex).toBe(1);
    expect(agent.lifetimeUsage).toMatchObject({ input: 11, output: 4, cacheWrite: 3 });
    expect(agent.toolUses).toBe(1);
    expect(agent.lifetimeTurnCount).toBe(2);
    expect(setup.io.open).toHaveBeenCalledExactlyOnceWith(fixture.file);
    const params = setup.createSession.mock.calls[0][0];
    expect(params.snapshot.parentContext).toBeUndefined();
    expect(params.cwd).toBe(fixture.cwd);
    expect(params.recovery!.manager.getSessionFile()).toBe(fixture.file);
    expect(existsSync(params.recovery!.lease.path)).toBe(true);

    let running: { index: number; usage: unknown; tools: number; turns: number; lifetime: unknown; limits: number[] } | undefined;
    setup.session.resumeTurnLoop.mockImplementationOnce(async () => {
      running = { index: agent.invocationIndex, usage: { ...agent.invocationUsage }, tools: agent.invocationToolUses,
        turns: agent.invocationTurnCount, lifetime: { ...agent.lifetimeUsage },
        limits: [agent.maxTurns, agent.wrapUpTurns, agent.maxDurationSeconds] };
      setup.mock.emit({ type: "message_end", message: assistantMessage("second", 2, 1, 0) });
      setup.mock.emit({ type: "turn_end" });
      return { responseText: "second", outcome: "completed", wrappedUp: false };
    });
    await setup.manager.resume(agent.id, "next prompt", { kind: "resume", source: "tool", toolCallId: "next-call" },
      { maxTurns: 100, wrapUpTurns: 10, maxDurationSeconds: 100 });
    expect(running).toEqual({ index: 2, usage: { input: 0, output: 0, cacheWrite: 0 }, tools: 0, turns: 0,
      lifetime: expect.objectContaining({ input: 11, output: 4, cacheWrite: 3 }), limits: [4, 3, 30] });
    expect(agent.invocationUsage).toEqual({ input: 2, output: 1, cacheWrite: 0 });
    expect(agent.lifetimeUsage).toMatchObject({ input: 13, output: 5, cacheWrite: 3 });
    expect(agent.lifetimeTurnCount).toBe(3);
    expect(agent.toolUses).toBe(1);
    expect(agent.toolCallId).toBe("next-call");
    expect(setup.createSession).toHaveBeenCalledTimes(1);
  });

  it.each(["disabled role", "different parent", "parent branch", "missing checkpoint", "v2 history", "missing cwd"])(
    "rejects %s before lease, open, registration or invocation mutation", async (scenario) => {
      const setup = arrange();
      if (scenario === "disabled role") setup.io.isEnabled.mockReturnValue(false);
      if (scenario === "different parent") setup.config.parentSession!.parentSessionId = "different-parent";
      if (scenario === "parent branch") fixture.parent.branch(fixture.anchor);
      if (scenario === "missing checkpoint") fixture.writeEntries(fixture.entries().slice(0, -1));
      if (scenario === "v2 history") {
        fixture.parent.branch(fixture.anchor);
        fixture.parent.appendCustomEntry("subagents:record", { ...fixture.record, recordVersion: 2, status: "completed" });
      }
      if (scenario === "missing cwd") rmSync(fixture.cwd, { recursive: true });
      const before = fixture.text();
      const parentBefore = readFileSync(fixture.parentFile, "utf8");
      await expect(setup.manager.restore(fixture.record.id, setup.snapshot, setup.config)).rejects.toThrow();
      assertUntouched(before, parentBefore, setup);
      expect(setup.io.acquireLease).not.toHaveBeenCalled();
      expect(fixture.record.invocationIndex).toBe(1);
    },
  );

  it("rejects a missing transcript instead of letting SDK.open create a replacement", async () => {
    const setup = arrange();
    unlinkSync(fixture.file);
    await expect(setup.manager.restore(fixture.record.id, setup.snapshot, setup.config)).rejects.toThrow();
    expect(existsSync(fixture.file)).toBe(false);
    expect(setup.io.open).not.toHaveBeenCalled();
    expect(setup.io.acquireLease).not.toHaveBeenCalled();
    expect(setup.createSession).not.toHaveBeenCalled();
    expect(setup.manager.listAgents()).toEqual([]);
  });

  it.each(["transcript tail", "parent branch"])("rereads %s after acquiring the lease and refuses stale preflight data", async (changed) => {
    const setup = arrange();
    let acquiredPath = "";
    setup.io.acquireLease.mockImplementationOnce((file, id) => {
      const lease = acquireSessionLease(file, id);
      acquiredPath = lease.path;
      if (changed === "transcript tail") fixture.writeEntries(fixture.entries().slice(0, -1));
      else fixture.parent.branch(fixture.anchor);
      return lease;
    });
    await expect(setup.manager.restore(fixture.record.id, setup.snapshot, setup.config)).rejects.toThrow();
    expect(acquiredPath).not.toBe("");
    expect(existsSync(acquiredPath)).toBe(false);
    expect(setup.io.open).not.toHaveBeenCalled();
    expect(setup.createSession).not.toHaveBeenCalled();
    expect(setup.manager.listAgents()).toEqual([]);
  });

  it("permits only one concurrent recovery and retains the winning lease", async () => {
    const setup = arrange();
    const gate = Promise.withResolvers<void>();
    setup.createSession.mockImplementationOnce(async () => { await gate.promise; return toSubagentSession(setup.session); });
    const first = setup.manager.restore(fixture.record.id, setup.snapshot, setup.config);
    await expect(setup.manager.restore(fixture.record.id, setup.snapshot, setup.config)).rejects.toThrow(/lease is already held/);
    expect(setup.manager.listAgents()).toEqual([]);
    gate.resolve();
    const winner = await first;
    expect(setup.manager.getRecord(fixture.record.id)).toBe(winner);
    expect(setup.createSession).toHaveBeenCalledTimes(1);
    expect(setup.io.open).toHaveBeenCalledTimes(1);
    const lease = setup.createSession.mock.calls[0][0].recovery!.lease;
    expect(existsSync(lease.path)).toBe(true);
    await expect(setup.manager.restore(fixture.record.id, setup.snapshot, setup.config)).rejects.toThrow(/active or still closing/);
    expect(winner.invocationIndex).toBe(1);
  });

  it("reports the retained marker when shutdown races an already-started recovery", async () => {
    const setup = arrange();
    const gate = Promise.withResolvers<void>();
    let marker = "";
    setup.createSession.mockImplementationOnce(async (params) => {
      marker = params.recovery!.lease.path;
      await gate.promise;
      return new SubagentSession(setup.mock as unknown as AgentSession, {
        sessionId: fixture.child.getSessionId(), outputFile: fixture.file, sessionDir: fixture.childDirectory,
        agentName: "Explore", parentContext: undefined, lifecycle: createChildLifecycleMock(),
        lease: params.recovery!.lease,
      });
    });
    const before = fixture.text();
    const pending = setup.manager.restore(fixture.record.id, setup.snapshot, setup.config);
    await setup.manager.settleInvocations();
    await setup.manager.dispose();
    gate.resolve();
    await expect(pending).rejects.toThrow(`ownership retained at ${marker}`);
    expect(existsSync(marker)).toBe(true);
    expect(fixture.text()).toBe(before);
    expect(setup.manager.listAgents()).toEqual([]);
    expect(setup.mock.dispose).toHaveBeenCalledOnce();
  });

  it("rejects a mismatching SDK.open identity and releases its uninitialized lease", async () => {
    const setup = arrange();
    setup.io.open.mockImplementationOnce((file) => {
      const manager = SessionManager.open(file);
      vi.spyOn(manager, "getSessionId").mockReturnValue("wrong-id");
      return manager;
    });
    await expect(recoverSubagent(fixture.record.id, setup.snapshot, setup.config, {
      io: setup.io, createSession: setup.createSession, observer: {},
    })).rejects.toThrow(/Opened child identity/);
    expect(setup.createSession).not.toHaveBeenCalled();
    const lease = acquireSessionLease(fixture.file, fixture.child.getSessionId());
    lease.release();
  });
});

describe("real SDK offline cold recovery", () => {
  it("creates, persists terminal, closes, reopens the same ID/file and resumes an actual AgentSession", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden in recovery smoke"); });
    const model = makeModel({ id: "offline-recovery-model", provider: "offline-recovery", baseUrl: "https://offline.invalid" });
    const runtime = await ModelRuntime.create({ authPath: join(fixture.root, "auth.json"),
      modelsPath: join(fixture.root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    // 仅绕过 SDK preflight 的认证判断；没有 credential、provider 请求或真实 stream。
    vi.spyOn(runtime, "hasConfiguredAuth").mockImplementation((provider) => provider === model.provider);
    const runningStreamStarted = Promise.withResolvers<void>();
    const stream = vi.fn((_model: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
      const events = new AssistantMessageEventStream();
      const message = assistantMessage(stream.mock.calls.length === 1 ? "first SDK answer" : "resumed SDK answer", 7, 3, 2);
      events.push({ type: "start", partial: message });
      if (stream.mock.calls.length === 3) {
        if (!options?.signal) throw new Error("SDK did not provide an abort signal");
        options.signal.addEventListener("abort", () => {
          events.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } });
        }, { once: true });
        runningStreamStarted.resolve();
      } else events.push({ type: "done", reason: "stop", message });
      return events;
    });
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const sdkSessions: AgentSession[] = [];
    let rejectNextBinding = true;
    const deps: SubagentSessionDeps = {
      exec: vi.fn(), registry: createAgentLookup(), lifecycle: createChildLifecycleMock(),
      io: {
        ...createSubagentSessionIO(), getAgentDir: () => join(fixture.root, "agent"),
        deriveSessionDir: () => fixture.childDirectory,
        createSessionManager: (cwd, directory) => SessionManager.create(cwd, directory),
        createSettingsManager: () => settings, createLoaderSettingsManager: (value) => value,
        acquireSessionLease,
        createResourceLoader: (options) => new DefaultResourceLoader({ ...options, noExtensions: true,
          noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true }),
        createSession: async (options) => {
          const result = await createAgentSession({ ...options, modelRuntime: runtime,
            sessionManager: options.sessionManager as SessionManager, resourceLoader: options.resourceLoader as DefaultResourceLoader });
          result.session.agent.streamFunction = stream;
          if (rejectNextBinding) {
            rejectNextBinding = false;
            vi.spyOn(result.session, "bindExtensions").mockRejectedValueOnce(new Error("offline binding failure"));
          }
          sdkSessions.push(result.session);
          return result;
        },
      },
    };
    const create = vi.fn((params: CreateSubagentSessionParams) => createSubagentSession(params, deps));
    let parentAvailable = true;
    const store = new PersistedSubagentStore(() => parentAvailable ? { id: fixture.parent.getSessionId(),
      file: fixture.parentFile, entries: fixture.parent.getBranch() } : undefined);
    const open = vi.fn((file: string) => SessionManager.open(file));
    const finished = vi.fn((agent) => persistTerminal(fixture.parent, agent, () => parentAvailable));
    const makeManager = () => new SubagentManager({
      createSubagentSession: create, limiter: new ConcurrencyLimiter(() => 1), baseCwd: fixture.cwd,
      coldResume: { store, isEnabled: () => true, acquireLease: acquireSessionLease, open },
      observer: { onSubagentStarted: vi.fn(), onSubagentCompleted: finished, onSubagentResumed: finished,
        onSubagentCreated: vi.fn(), onSubagentCompacted: vi.fn() },
    });
    const manager = makeManager();
    managers.push(manager);
    const snapshot = { ...STUB_SNAPSHOT, cwd: fixture.cwd, model };
    const config: AgentSpawnConfig = { description: "SDK smoke", maxTurns: 4, wrapUpTurns: 1, maxDurationSeconds: 30,
      parentSession: { parentSessionId: fixture.parent.getSessionId(), parentSessionFile: fixture.parentFile } };
    const failed = await manager.spawnAndWait(snapshot, "Explore", "bind failure task", config);
    expect(failed.outcome).toBe("error");
    await failed.releaseSession();
    expect(failed.sessionReleased).toBe(true);
    expect(existsSync(join(fixture.childDirectory, `.${failed.sessionId}.subagents-lease`))).toBe(false);
    expect(stream).not.toHaveBeenCalled();
    const first = await manager.spawnAndWait(snapshot, "Explore", "original SDK task", config);
    expect(first.outcome, first.error).toBe("completed");
    expect(first.result).toBe("first SDK answer");
    expect(sdkSessions[1]).toBeInstanceOf(AgentSession);
    const id = first.id;
    const sessionId = first.sessionId;
    const outputFile = first.outputFile!;
    const leasePath = join(fixture.childDirectory, `.${sessionId}.subagents-lease`);
    expect(existsSync(leasePath)).toBe(true);
    const lifecycle = new SessionLifecycleHandler({
      setSessionContext: () => { parentAvailable = true; },
      clearSessionContext: () => { parentAvailable = false; },
    }, manager, vi.fn(), vi.fn());
    await lifecycle.handleSessionShutdown();
    expect(parentAvailable).toBe(false);
    expect(first.sessionReleased).toBe(true);
    expect(existsSync(leasePath)).toBe(false);
    parentAvailable = true;
    expect(validateRecoveryTranscript(readFileSync(outputFile, "utf8"), store.get(id)!).checkpoint.agentId).toBe(id);
    const filesBefore = readdirSync(fixture.childDirectory).sort();
    const restarted = makeManager();
    managers.push(restarted);
    const recovered = await restarted.restore(id, snapshot, config);
    expect(recovered.id).toBe(id);
    expect(recovered.sessionId).toBe(sessionId);
    expect(recovered.invocationIndex).toBe(1);
    expect(recovered.lifetimeUsage).toMatchObject({ input: 7, output: 3, cacheWrite: 2 });
    expect(sdkSessions[2]).toBeInstanceOf(AgentSession);
    expect(sdkSessions[2]).not.toBe(sdkSessions[1]);
    expect(sdkSessions[2].messages.some((message) => message.role === "assistant")).toBe(true);
    expect(open).toHaveBeenCalledExactlyOnceWith(outputFile);
    expect(readdirSync(fixture.childDirectory).filter((name) => !name.endsWith("subagents-lease")).sort()).toEqual(filesBefore);
    await restarted.resume(id, "continue SDK task", { kind: "resume", source: "tool", toolCallId: "sdk-resume-call" });
    expect(recovered.outcome, recovered.error).toBe("completed");
    expect(recovered.result).toBe("resumed SDK answer");
    expect(recovered.invocationIndex).toBe(2);
    expect(recovered.invocationUsage).toEqual({ input: 7, output: 3, cacheWrite: 2 });
    expect(recovered.lifetimeUsage).toMatchObject({ input: 14, output: 6, cacheWrite: 4 });
    expect(recovered.invocationTurnCount).toBe(1);
    expect(recovered.lifetimeTurnCount).toBe(2);
    await recovered.releaseSession();
    expect(recovered.sessionReleased).toBe(true);
    const history = store.get(id)!;
    expect(history.invocations.map((entry) => entry.record.invocationIndex)).toEqual([1, 2]);
    expect(validateRecoveryTranscript(readFileSync(outputFile, "utf8"), history).checkpoint.invocationIndex).toBe(2);
    expect(create).toHaveBeenCalledTimes(3);
    expect(stream).toHaveBeenCalledTimes(2);
    expect(finished).toHaveBeenCalledTimes(3);
    const runningId = restarted.spawn(snapshot, "Explore", "cancel at shutdown", { ...config, isBackground: true });
    await runningStreamStarted.promise;
    const running = restarted.getRecord(runningId)!;
    const runningLease = join(fixture.childDirectory, `.${running.sessionId}.subagents-lease`);
    expect(existsSync(runningLease)).toBe(true);
    const runningShutdown = new SessionLifecycleHandler({
      setSessionContext: () => { parentAvailable = true; },
      clearSessionContext: () => { parentAvailable = false; },
    }, restarted, vi.fn(), vi.fn());
    await runningShutdown.handleSessionShutdown();
    expect(parentAvailable).toBe(false);
    expect(running.outcome).toBe("cancelled");
    expect(running.sessionReleased).toBe(true);
    expect(existsSync(runningLease)).toBe(false);
    parentAvailable = true;
    expect(validateRecoveryTranscript(readFileSync(running.outputFile!, "utf8"), store.get(runningId)!).checkpoint.agentId).toBe(runningId);
    expect(stream).toHaveBeenCalledTimes(3);
    expect(finished).toHaveBeenCalledTimes(4);
    expect(network).not.toHaveBeenCalled();
  });
});
