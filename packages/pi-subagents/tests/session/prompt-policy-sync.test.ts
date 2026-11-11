import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage, createAssistantMessageEventStream, getCurrentSystemMessage, getCurrentTools,
  type Message, type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  type BeforeAgentStartEvent, createAgentSession, DefaultResourceLoader, type ExtensionAPI, type ExtensionFactory,
  ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentSession, type SubagentSessionIO } from "#src/lifecycle/create-subagent-session";
import type { SubagentSession } from "#src/lifecycle/subagent-session";
import { makeModel } from "#test/helpers/make-model";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import { createAgentLookup, createSubagentSessionDeps, createSubagentSessionIO } from "#test/helpers/subagent-session-io";

interface HostOptions {
  initial?: string[];
  advanced?: boolean;
  noSource?: boolean;
  before?: (event: BeforeAgentStartEvent, pi: ExtensionAPI) => void;
  context?: ExtensionFactory;
}

const ALL_TOOLS = ["read", "agent_browser", "update_task_status", "hide_tools", "flip_tools"];
const model = makeModel({ provider: "offline-prompt-sync", baseUrl: "https://offline.invalid" });
const sandboxRoots: string[] = [];
const children: SubagentSession[] = [];
let network: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden in prompt synchronization regression"); });
});

afterEach(async () => {
  for (const child of children.splice(0).reverse()) await child.dispose();
  for (const root of sandboxRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  expect(network).not.toHaveBeenCalled();
  network.mockRestore();
  vi.unstubAllEnvs();
});

async function createHost(options: HostOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "prompt-policy-sync-"));
  sandboxRoots.push(root);
  const agentDir = join(root, "agent");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false, allowModelNetwork: false,
  });
  runtime.hasConfiguredAuth = (provider) => provider === model.provider;
  const state = { body: "fresh child browser", hidden: ["read", "agent_browser", "update_task_status"], nextTools: ["read"] };
  const tools = [...ALL_TOOLS, ...(options.advanced ? ["agent_browser_preview", "agent_browser_inactive"] : [])];
  const fixture: ExtensionFactory = (pi) => {
    for (const name of tools.filter((name) => name !== "read")) {
      pi.registerTool({
        name, label: name, description: `Offline ${name}`, parameters: { type: "object", properties: {} },
        ...(name === "agent_browser_preview" ? { exposure: "codemode" as const } : {}),
        ...(name === "agent_browser_inactive" ? { defaultActive: false } : {}),
        ...(name === "hide_tools" ? { prepareLoadout: () => ({ hiddenDeclarations: state.hidden }) } : {}),
        execute: async () => {
          if (name === "flip_tools") pi.setActiveTools(state.nextTools);
          return { content: [{ type: "text", text: "ok" }], details: {} };
        },
      });
    }
    pi.on("before_agent_start", (event) => {
      if (!options.noSource) {
        event.systemPromptOptions.sections.agent_browser = state.body;
        event.systemPromptOptions.sections.task_status = "fresh child status";
      }
      options.before?.(event, pi);
    });
  };
  const parent = {
    cwd: root, customPrompt: "parent preamble mentioning agent_browser",
    appendSystemPrompt: "APPEND mentions agent_browser and update_task_status",
    sections: {
      operator: "user custom text mentioning agent_browser",
      ...(options.noSource ? {} : { agent_browser: "old parent browser", task_status: "old parent status" }),
    },
    contextFiles: [{ path: join(root, "AGENTS.md"), content: "user project rules mentioning agent_browser" }],
  };
  const frozenParent = structuredClone(parent);
  const manager = SessionManager.inMemory(root);
  const baseIO = createSubagentSessionIO();
  let loader: DefaultResourceLoader;
  const io: SubagentSessionIO = {
    ...baseIO,
    getAgentDir: () => agentDir,
    createSettingsManager: () => settings,
    createLoaderSettingsManager: (value) => value,
    createSessionManager: () => manager,
    createResourceLoader: (opts) => {
      loader = new DefaultResourceLoader({
        ...opts, noExtensions: true, noSkills: true,
        extensionFactories: [fixture, ...(options.context ? [options.context] : []), ...(opts.extensionFactories ?? [])],
      });
      return loader;
    },
    createSession: (opts) => createAgentSession({ ...opts, resourceLoader: loader, sessionManager: manager, modelRuntime: runtime }),
  };
  const deps = { ...createSubagentSessionDeps({ registry: createAgentLookup({ toolNames: tools }) }), io };
  const snapshot = { ...STUB_SNAPSHOT, cwd: root, model, promptOptions: parent, availableTools: tools, projectTrusted: false };
  const child = await createSubagentSession({ snapshot, type: "Explore" }, deps);
  children.push(child);
  const session = child.session;
  session.setActiveToolsByName(options.initial ?? ["read", "agent_browser", "update_task_status"]);
  const requests: TranscriptContext[] = [];
  let callTools = false;
  session.agent.streamFunction = (_model, context) => {
    requests.push(structuredClone(context));
    const content: AssistantMessage["content"] = callTools
      ? [{ type: "toolCall", id: `flip-${requests.length}`, name: "flip_tools", arguments: {} }]
      : [{ type: "text", text: "ok" }];
    const reason = callTools ? "toolUse" : "stop";
    callTools = false;
    const message: AssistantMessage = {
      role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
      stopReason: reason, timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason, message });
    return stream;
  };
  return { session, state, requests, parent, frozenParent, invokeTool: () => { callTools = true; } };
}

function expectRequest(context: TranscriptContext, visible: string[], browser: boolean, status = false, body = "fresh child browser") {
  expect(getCurrentTools(context.messages).map((tool) => tool.name).sort()).toEqual(visible.slice().sort());
  const sections = getCurrentSystemMessage(context.messages)?.sections;
  expect(sections?.subagent_identity).toContain(`Directly available tools this round: ${visible.length ? visible.slice().sort().join(", ") : "none"}.`);
  expect(sections?.subagent_identity?.match(/Directly available tools this round/g)).toHaveLength(1);
  if (browser) expect(sections?.agent_browser).toBe(`<agent_browser>\n${body}\n</agent_browser>`);
  else expect(sections?.agent_browser).toBeUndefined();
  if (status) expect(sections?.task_status).toBe("<task_status>\nfresh child status\n</task_status>");
  else expect(sections?.task_status).toBeUndefined();
  expect(sections?.operator).toContain("user custom text mentioning agent_browser");
  expect(sections?.addendum).toContain("APPEND mentions agent_browser and update_task_status");
  expect(sections?.project_context).toContain("user project rules mentioning agent_browser");
}

describe("final prompt policy through real SDK requests", () => {
  it("tracks live disable/enable across runs and recaptures fresh child bodies without changing parent or siblings", async () => {
    let enabled = false;
    const host = await createHost({ before: (_event, pi) => pi.setActiveTools(enabled ? ["read", "agent_browser"] : ["read"]) });
    const sibling = await createHost();
    await host.session.prompt("first");
    expectRequest(host.requests[0], ["read"], false);
    enabled = true;
    host.state.body = "new child browser";
    await host.session.prompt("second");
    expectRequest(host.requests[1], ["read", "agent_browser"], true, false, "new child browser");
    expect(host.parent).toEqual(host.frozenParent);
    expect(sibling.parent).toEqual(sibling.frozenParent);
    expect(sibling.session.messages).toEqual([]);
    await sibling.session.prompt("sibling");
    expectRequest(sibling.requests[0], ["read", "agent_browser", "update_task_status"], true, true);
  });

  it("gives explicit selectedTools priority over a conflicting live active set", async () => {
    const host = await createHost({ before: (event, pi) => {
      pi.setActiveTools(["read"]);
      event.systemPromptOptions.selectedTools = ["agent_browser", "update_task_status"];
    } });
    await host.session.prompt("explicit");
    expectRequest(host.requests[0], ["agent_browser", "update_task_status"], true, true);
  });

  it("respects an explicit empty final selection", async () => {
    const host = await createHost({ before: (event) => { event.systemPromptOptions.selectedTools = []; } });
    await host.session.prompt("empty");
    expectRequest(host.requests[0], [], false);
  });

  it.each([false, true])("uses post-loadout declarations when the hider is enabled during startup: %s", async (duringStartup) => {
    const active = ["read", "agent_browser", "update_task_status", "hide_tools"];
    const host = await createHost({
      initial: duringStartup ? ["read"] : active,
      before: duringStartup ? (_event, pi) => pi.setActiveTools(active) : undefined,
    });
    await host.session.prompt("hidden");
    expectRequest(host.requests[0], ["hide_tools"], true, true);
    expect(host.session.getCallableToolNames()).toContain("agent_browser");
    expect(getCurrentTools(host.session.messages).map((tool) => tool.name)).toContain("read");
    const sourceIdentity = getCurrentSystemMessage(host.session.messages)?.sections?.subagent_identity;
    expect(sourceIdentity).toContain(`Directly available tools this round: ${duringStartup ? "read" : "hide_tools"}.`);
    expect(host.session.systemPrompt).not.toContain("Directly available tools this round: hide_tools.");
    expect(getCurrentSystemMessage(host.requests[0].messages)?.sections?.subagent_identity).not.toContain("read");
  });

  it("retains browser guidance for a callable advanced tool without listing it as directly visible", async () => {
    const host = await createHost({ initial: ["read"], advanced: true });
    await host.session.prompt("advanced");
    expectRequest(host.requests[0], ["read"], true);
    expect(host.session.getCallableToolNames()).toContain("agent_browser_preview");
    expect(host.session.getCallableToolNames()).not.toContain("agent_browser_inactive");
  });

  it.each([false, true])("refreshes every request after a tool changes the loadout (enable: %s)", async (enable) => {
    const host = await createHost({ initial: enable ? ["flip_tools"] : ["agent_browser", "update_task_status", "flip_tools"] });
    host.state.nextTools = enable ? ["flip_tools", "agent_browser", "update_task_status"] : ["flip_tools"];
    host.invokeTool();
    await host.session.prompt("flip in one run");
    expect(host.requests).toHaveLength(2);
    expectRequest(host.requests[0], enable ? ["flip_tools"] : ["agent_browser", "update_task_status", "flip_tools"], !enable, !enable);
    expectRequest(host.requests[1], host.state.nextTools, enable, enable);
    expect(host.requests[1].messages.some((message) => message.role === "toolResult")).toBe(true);
  });

  it("updates the bound synchronization function on reload without stacking wrappers or stale APIs", async () => {
    const host = await createHost();
    await host.session.prompt("before reload");
    const wrapper = host.session.agent.transformContext;
    await host.session.reload();
    expect(host.session.agent.transformContext).toBe(wrapper);
    host.state.body = "browser after reload";
    host.session.setActiveToolsByName(["read"]);
    await host.session.prompt("after reload");
    expectRequest(host.requests[1], ["read"], false);
    host.session.setActiveToolsByName(["agent_browser"]);
    await host.session.prompt("restored");
    expectRequest(host.requests[2], ["agent_browser"], true, false, "browser after reload");
  });

  it("does not invent guidance when neither parent nor child supplied the section", async () => {
    const host = await createHost({ noSource: true });
    await host.session.prompt("no sections");
    expectRequest(host.requests[0], ["read", "agent_browser", "update_task_status"], false);
  });

  it("preserves forced plain text without projecting named sections into it", async () => {
    const host = await createHost({ before: (event) => { event.systemPromptOptions.forceSystemPrompt = "opaque agent_browser instruction"; } });
    await host.session.prompt("opaque");
    expect(host.requests[0].messages[0]).toMatchObject({ role: "system", content: "opaque agent_browser instruction" });
    expect(getCurrentSystemMessage(host.requests[0].messages)?.sections).toBeUndefined();
  });

  it("removes known stale mid-conversation patches while preserving unrelated context and tool declarations", async () => {
    const patch: Message = { role: "system", content: "keep context content", sections: {
      agent_browser: "old patched browser", task_status: "old patched status", subagent_identity: "old patched identity", hermes: "keep hermes",
    }, timestamp: 42 };
    const before = structuredClone(patch);
    const host = await createHost({ initial: ["read"], context: (pi) => {
      pi.on("context_with_system", (event) => ({ messages: [...event.messages, patch] }));
    } });
    await host.session.prompt("context patch");
    expectRequest(host.requests[0], ["read"], false);
    const projected = host.requests[0].messages.find((message) => message.role === "system" && message.timestamp === 42);
    expect(projected).toMatchObject({ content: "keep context content", sections: { hermes: "keep hermes" } });
    expect(patch).toEqual(before);
  });
});
