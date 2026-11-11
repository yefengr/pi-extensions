import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extensionFactory from "../src/extension.ts";
import { TASK_STATUS_INSTRUCTIONS, TASK_STATUS_SECTION, TOOL_NAME } from "../src/instructions.ts";

process.env.PI_CODING_AGENT_DIR = path.join(tmpdir(), "task-status-prompt-missing-agent");

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
function createHost() {
  const handlers = new Map<string, Handler>();
  const status: Array<string | undefined> = [];
  let review = false;
  let activeTools = [TOOL_NAME];
  const ctx = {
    hasUI: true,
    ui: { setStatus: (_key: string, text: string | undefined) => status.push(text), theme: { fg: (_color: string, text: string) => text } },
    sessionManager: { getBranch: () => review ? [{ type: "custom", customType: "task-efficiency:source", data: {} }] : [] },
  } as unknown as ExtensionContext;
  extensionFactory({
    registerTool() {},
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getActiveTools: () => [...activeTools],
    setActiveTools: (tools: string[]) => { activeTools = [...tools]; },
  } as unknown as ExtensionAPI);
  return {
    status,
    activeTools: () => [...activeTools],
    setReview(value: boolean) { review = value; },
    async emit(name: string, event: unknown = {}) { return await handlers.get(name)!(event, ctx); },
  };
}

function event(selectedTools: string[] = [TOOL_NAME]): BeforeAgentStartEvent {
  return {
    type: "before_agent_start", messageType: "user", prompt: "task",
    // Rendered text is deliberately opaque to the extension.
    systemPrompt: "user text [task-status-extension]",
    systemPromptOptions: {
      cwd: "/isolated", selectedTools, hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: ["user guideline"],
      appendSystemPrompt: "user append", sections: { operator: "user section" }, contextFiles: [], skills: [],
    },
  };
}

test("structured task-status injection is idempotent and never forces the rendered prompt", async () => {
  const host = createHost();
  const run = event();
  for (let index = 0; index < 2; index += 1) {
    assert.equal(await host.emit("before_agent_start", run), undefined);
    assert.equal(run.systemPromptOptions.sections[TASK_STATUS_SECTION], TASK_STATUS_INSTRUCTIONS);
    assert.equal(run.systemPromptOptions.forceSystemPrompt, undefined);
    assert.deepEqual(Object.keys(run.systemPromptOptions.sections), ["operator", TASK_STATUS_SECTION]);
    assert.deepEqual(run.systemPromptOptions.promptGuidelines, ["user guideline"]);
    assert.equal(run.systemPromptOptions.appendSystemPrompt, "user append");
  }
  const next = event();
  await host.emit("before_agent_start", next);
  assert.equal(next.systemPromptOptions.sections[TASK_STATUS_SECTION], TASK_STATUS_INSTRUCTIONS);
});

test("absent selected tool removes only the owned section", async () => {
  const host = createHost();
  const run = event(["read"]);
  run.systemPromptOptions.sections[TASK_STATUS_SECTION] = "stale task status";
  assert.equal(await host.emit("before_agent_start", run), undefined);
  assert.deepEqual(run.systemPromptOptions.sections, { operator: "user section" });
  assert.deepEqual(run.systemPromptOptions.promptGuidelines, ["user guideline"]);
  assert.deepEqual(host.activeTools(), [TOOL_NAME]);
});

test("review removes an existing section, tool and footer; returning restores normal injection", async () => {
  const host = createHost();
  await host.emit("session_start");
  const run = event();
  await host.emit("before_agent_start", run);
  host.setReview(true);
  await host.emit("before_agent_start", run);
  assert.deepEqual(run.systemPromptOptions.sections, { operator: "user section" });
  assert.deepEqual(host.activeTools(), []);
  assert.equal(host.status.at(-1), undefined);
  // Repeated review runs must retain the restoration decision.
  await host.emit("before_agent_start", run);
  host.setReview(false);
  await host.emit("session_tree");
  assert.deepEqual(host.activeTools(), [TOOL_NAME]);
  await host.emit("before_agent_start", event(host.activeTools()));
  const resumed = event(host.activeTools());
  await host.emit("before_agent_start", resumed);
  assert.equal(resumed.systemPromptOptions.sections[TASK_STATUS_SECTION], TASK_STATUS_INSTRUCTIONS);
});
