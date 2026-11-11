import type { Message } from "@earendil-works/pi-ai";
import type { BuildSystemPromptOptions, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createPromptInheritanceExtension, inheritPromptOptions, mergePromptAddenda, type ToolPromptSync } from "#src/session/prompt-inheritance";

const parent: BuildSystemPromptOptions = {
  cwd: "/parent", customPrompt: "custom preamble", appendSystemPrompt: "user addendum",
  selectedTools: ["write"], skills: [],
  sections: { operator: "keep exact custom section", cwd: "stale cwd" },
  contextFiles: [
    { path: "/agent/AGENTS.md", content: "user rules" },
    { path: "/parent/AGENTS.md", content: "parent project rules" },
  ],
};

describe("structured prompt inheritance", () => {
  it("keeps custom content while rebuilding target resources and tool declarations", () => {
    const child: BuildSystemPromptOptions = {
      cwd: "/child", appendSystemPrompt: "user addendum", selectedTools: ["read"], hiddenTools: [],
      toolSnippets: { read: "read current files" }, toolGuidelines: { read: ["read first"] },
      skills: [], contextFiles: [
        { path: "/agent/AGENTS.md", content: "current user rules" },
        { path: "/child/AGENTS.md", content: "target rules" },
      ],
    };
    const result = inheritPromptOptions(parent, child, "<active_agent name=\"child\"/>", "/agent");
    expect(result.customPrompt).toBe("custom preamble");
    expect(result.appendSystemPrompt).toBe("user addendum");
    expect(result.selectedTools).toEqual(["read"]);
    expect(result.toolSnippets).toEqual(child.toolSnippets);
    expect(result.toolGuidelines).toEqual(child.toolGuidelines);
    expect(result.contextFiles).toEqual(child.contextFiles);
    const { operator, cwd, subagent_identity: identity } = result.sections ?? {};
    expect({ operator, cwd }).toEqual({ operator: "keep exact custom section", cwd: "stale cwd" });
    expect(identity).toMatch(/^<active_agent name="child"\/>\n\nDirectly available tools this round: read\./);
    expect(parent.sections?.cwd).toBe("stale cwd");
  });

  it("keeps same-directory rules once and prefers the child's fresh content", () => {
    const child = { cwd: "/parent", contextFiles: [{ path: "/agent/AGENTS.md", content: "fresh" }] };
    const result = inheritPromptOptions(parent, child, "identity", "/agent");
    expect(result.contextFiles).toEqual([
      { path: "/agent/AGENTS.md", content: "fresh" },
      { path: "/parent/AGENTS.md", content: "parent project rules" },
    ]);
  });

  it("preserves explicit built-in-named sections verbatim", () => {
    const sections = { tools: "user tools text", rules: "user rules text", cwd: "user cwd note", project_context: "user context", skills: "user skills" };
    const result = inheritPromptOptions({ ...parent, sections, appendSystemPrompt: undefined }, { cwd: "/child" }, "identity", "/agent");
    expect(result.sections).toMatchObject(sections);
  });

  it("refuses ambiguous APPEND scope when changing directories", () => {
    expect(() => inheritPromptOptions(parent, { cwd: "/child", appendSystemPrompt: "target project APPEND" }, "identity", "/agent", ["target project APPEND"]))
      .toThrow("verified source metadata");
  });

  it("loads target APPEND when the parent has none", () => {
    const result = inheritPromptOptions({ ...parent, appendSystemPrompt: undefined }, { cwd: "/child", appendSystemPrompt: "target project APPEND" }, "identity", "/agent");
    expect(result.appendSystemPrompt).toBe("target project APPEND");
  });

  it("deduplicates known source bodies while keeping late-handler additions and paragraph text", () => {
    expect(mergePromptAddenda("shared resource\n\nparent handler", "shared resource\n\nchild handler", ["shared resource"]))
      .toBe("parent handler\n\nshared resource\n\nchild handler");
    expect(mergePromptAddenda("exact same", "exact same", ["exact same"])).toBe("exact same");
    expect(mergePromptAddenda("prefix shared resource suffix", "shared resource", ["shared resource"]))
      .toBe("prefix shared resource suffix\n\nshared resource");
  });

  it.each(["/parent", "/child"])("drops only task_status without the child's tool at %s", (cwd) => {
    const source: BuildSystemPromptOptions = {
      ...parent, sections: { ...parent.sections, task_status: "parent task status" },
      promptGuidelines: ["user guideline mentioning update_task_status"],
      toolSnippets: { update_task_status: "parent snippet" },
      toolGuidelines: { update_task_status: ["parent tool guideline"] },
    };
    const before = structuredClone(source);
    const child: BuildSystemPromptOptions = {
      cwd, selectedTools: ["read"], sections: { child: "child section", task_status: "stale child section" },
      promptGuidelines: ["child guideline"], toolSnippets: { read: "fresh snippet" }, toolGuidelines: { read: ["fresh guideline"] },
      appendSystemPrompt: parent.appendSystemPrompt,
    };
    const result = inheritPromptOptions(source, child, "identity", "/agent");
    expect(result.sections).toMatchObject({ ...parent.sections, child: "child section" });
    expect(result.sections?.subagent_identity).toMatch(/^identity\n\nDirectly available tools this round: read\./);
    expect(result.promptGuidelines).toEqual(["user guideline mentioning update_task_status", "child guideline"]);
    expect(result.selectedTools).toEqual(["read"]);
    expect(result.toolSnippets).toEqual(child.toolSnippets);
    expect(result.toolGuidelines).toEqual(child.toolGuidelines);
    expect(source).toEqual(before);
    expect(child.sections?.task_status).toBe("stale child section");
  });

  it("omits task_status when no tools are selected and retains it when the child has the tool", () => {
    const source = { ...parent, sections: { task_status: "inherited instructions" } };
    expect(inheritPromptOptions(source, { cwd: "/parent" }, "identity", "/agent").sections?.task_status).toBeUndefined();
    const child = { cwd: "/parent", selectedTools: ["update_task_status"] };
    expect(inheritPromptOptions(source, child, "identity", "/agent").sections?.task_status).toBe("inherited instructions");
    expect(inheritPromptOptions(source, { ...child, sections: { task_status: "fresh instructions" } }, "identity", "/agent").sections?.task_status)
      .toBe("fresh instructions");
  });

  it("rejects opaque forced prompts even when empty", () => {
    expect(() => inheritPromptOptions({ ...parent, forceSystemPrompt: "" }, { cwd: "/child" }, "role", "/agent"))
      .toThrow("opaque forceSystemPrompt");
  });
});

describe("request-only tool prompt synchronization", () => {
  function createSync(sections: Record<string, string> = { agent_browser: "fresh browser", task_status: "fresh status" }) {
    let sync: ToolPromptSync | undefined;
    let start: ((event: { systemPromptOptions: BuildSystemPromptOptions }) => void) | undefined;
    createPromptInheritanceExtension({ cwd: "/parent" }, "fixed identity", "/agent", undefined,
      (value) => { sync = value; })({
      getAllTools: () => [],
      on: (_event: string, handler: typeof start) => { start = handler; },
    } as unknown as Parameters<ExtensionFactory>[0]);
    start?.({ systemPromptOptions: { cwd: "/parent", selectedTools: [], sections } });
    if (!sync) throw new Error("Missing sync binding");
    return sync;
  }

  it("preserves message order, opaque text, tool deltas, and unrelated sections without mutating inputs", () => {
    const sync = createSync();
    const messages: Message[] = [
      { role: "system", content: "plain text mentioning agent_browser", sections: {
        subagent_identity: "old identity", agent_browser: "old browser", tools: "user tools", hermes: "keep Hermes",
      }, toolsAdded: [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }], timestamp: 0 },
      { role: "user", content: "user mentions update_task_status", timestamp: 1 },
      { role: "system", content: [{ type: "text", text: "keep original content" }], sections: {
        task_status: "old status", agent_browser: null, subagent_identity: "patched identity", other: "other patch",
      }, toolsRemoved: [{ name: "read" }], toolsAdded: [{ name: "write", description: "write", parameters: { type: "object", properties: {} } }], timestamp: 2 },
    ];
    const before = structuredClone(messages);
    const projected = sync(messages, [], ["write"]);
    expect(projected).not.toBe(messages);
    expect(projected).toHaveLength(messages.length);
    expect(projected[1]).toBe(messages[1]);
    for (const index of [0, 2]) {
      const source = messages[index];
      const target = projected[index];
      if (source.role !== "system" || target.role !== "system") throw new Error("Expected system message");
      expect(target.content).toBe(source.content);
      expect(target.toolsAdded).toBe(source.toolsAdded);
      expect(target.toolsRemoved).toBe(source.toolsRemoved);
      expect(target.timestamp).toBe(source.timestamp);
    }
    expect(projected[0]).toMatchObject({ sections: { tools: "user tools", hermes: "keep Hermes", subagent_identity: expect.stringContaining("write.") } });
    expect(projected[2]).toMatchObject({ sections: { other: "other patch" } });
    expect((projected[2] as Extract<Message, { role: "system" }>).sections).not.toHaveProperty("subagent_identity");
    expect(messages).toEqual(before);
    expect(sync(projected, [], ["write"])).toBe(projected);
  });

  it("uses only declared final tools in the summary while retaining hidden authorized guidance", () => {
    const sync = createSync();
    const messages: Message[] = [{ role: "system", content: "", sections: { subagent_identity: "old identity" }, timestamp: 0 }];
    const result = sync(messages, ["agent_browser_advanced", "update_task_status"], ["update_task_status"]);
    expect(result[0]).toMatchObject({ sections: {
      subagent_identity: expect.stringContaining("Directly available tools this round: none."),
      agent_browser: "<agent_browser>\nfresh browser\n</agent_browser>",
      task_status: "<task_status>\nfresh status\n</task_status>",
    } });
    expect((result[0] as Extract<Message, { role: "system" }>).sections?.subagent_identity).not.toContain("agent_browser_advanced");
  });

  it.each<Message[][]>([
    [[]],
    [[{ role: "user", content: "opaque user text", timestamp: 0 }]],
    [[{ role: "system", content: "opaque force prompt", timestamp: 0 }]],
    [[{ role: "system", content: "", sections: { operator: "unrelated metadata" }, timestamp: 0 }]],
  ])("keeps missing or unreliable structured prompt metadata unchanged", (messages) => {
    expect(createSync()(messages, ["agent_browser"], ["agent_browser"])).toBe(messages);
  });
});

describe("browser guidance and tool availability", () => {
  const browserParent: BuildSystemPromptOptions = {
    ...parent, sections: { ...parent.sections, agent_browser: "parent browser guidance" },
  };

  it("drops parent and child browser sections without a browser tool", () => {
    const child = { cwd: "/parent", selectedTools: ["read"], sections: { agent_browser: "stale child browser guidance" } };
    const result = inheritPromptOptions(browserParent, child, "identity", "/agent");
    expect(result.sections).not.toHaveProperty("agent_browser");
    expect(child.sections.agent_browser).toBe("stale child browser guidance");
    expect(browserParent.sections?.agent_browser).toBe("parent browser guidance");
  });

  it.each(["agent_browser", "agent_browser_advanced"])("retains the browser section for %s", (tool) => {
    const result = inheritPromptOptions(browserParent, { cwd: "/parent", selectedTools: [tool] }, "identity", "/agent");
    expect(result.sections?.agent_browser).toBe("parent browser guidance");
  });

  it("prefers child browser content and accepts only indirectly callable browser tools", () => {
    const child = {
      cwd: "/parent", selectedTools: ["read", "agent_browser"], sections: { agent_browser: "fresh browser guidance" },
    };
    expect(inheritPromptOptions(browserParent, child, "identity", "/agent").sections?.agent_browser)
      .toBe("fresh browser guidance");
    const indirect = (tools: readonly string[]) => inheritPromptOptions(
      browserParent, { cwd: "/parent", selectedTools: ["read"] }, "identity", "/agent", [], tools,
    ).sections?.agent_browser;
    expect(indirect(["agent_browser_advanced"])).toBe("parent browser guidance");
    expect(indirect(["agent_browserish", "browser_agent"])).toBeUndefined();
  });

  it("keeps APPEND, guidelines, and custom sections that mention browser tools", () => {
    const source = { ...browserParent, promptGuidelines: ["use agent_browser carefully"] };
    const child = {
      cwd: "/parent", selectedTools: ["read"], appendSystemPrompt: "APPEND mentions agent_browser",
      promptGuidelines: ["child mentions agent_browser"], sections: { rules: "user rules mentioning agent_browser" },
    };
    const result = inheritPromptOptions(source, child, "identity", "/agent");
    expect(result.sections?.agent_browser).toBeUndefined();
    expect(result.sections?.rules).toBe("user rules mentioning agent_browser");
    expect(result.appendSystemPrompt).toBe("user addendum\n\nAPPEND mentions agent_browser");
    expect(result.promptGuidelines).toEqual(["use agent_browser carefully", "child mentions agent_browser"]);
  });

  it("summarizes directly visible tools once and builds from the fixed identity each round", () => {
    const child = { cwd: "/parent", selectedTools: ["write", "read", "read"], hiddenTools: ["write"] };
    const first = inheritPromptOptions(parent, child, "identity", "/agent");
    const second = inheritPromptOptions(parent, first, "identity", "/agent");
    expect(first.sections?.subagent_identity).toContain("Directly available tools this round: read.");
    expect(first.sections?.subagent_identity).not.toContain("write");
    expect(second.sections?.subagent_identity).toBe(first.sections?.subagent_identity);
    expect(second.sections?.subagent_identity?.match(/Directly available tools this round/g)).toHaveLength(1);
  });

  it("distinguishes an explicit empty tool set from missing metadata", () => {
    const empty = inheritPromptOptions(parent, { cwd: "/parent", selectedTools: [] }, "identity", "/agent");
    expect(empty.sections?.subagent_identity).toContain("Directly available tools this round: none.");
    const unknown = inheritPromptOptions(parent, { cwd: "/parent" }, "identity", "/agent");
    expect(unknown.sections?.subagent_identity).toContain("not declared in this session's prompt metadata");
    expect(unknown.sections?.subagent_identity).not.toContain("Directly available tools this round");
    expect(unknown.sections?.subagent_identity).not.toContain("none");
  });

  it("does not mutate inputs or leak one sibling's guidance into another", () => {
    const source = structuredClone(browserParent);
    const childA = { cwd: "/parent", selectedTools: ["read", "agent_browser"], sections: { agent_browser: "child browser guidance" } };
    const childB = { cwd: "/parent", selectedTools: ["write"] };
    const beforeA = structuredClone(childA);
    const beforeB = structuredClone(childB);
    const a = inheritPromptOptions(source, childA, "identity", "/agent");
    const b = inheritPromptOptions(source, childB, "identity", "/agent");
    expect(a.sections?.agent_browser).toBe("child browser guidance");
    expect(b.sections).not.toHaveProperty("agent_browser");
    expect(b.sections?.subagent_identity).not.toContain("read");
    expect(source).toEqual(browserParent);
    expect(childA).toEqual(beforeA);
    expect(childB).toEqual(beforeB);
  });

  it("passes only codemode/deferred registered tools as indirect browser capability", () => {
    const handlers: Array<(event: { systemPromptOptions: BuildSystemPromptOptions }) => void> = [];
    const tools = [
      { name: "agent_browser_preview", exposure: "codemode" },
      { name: "other_codemode", exposure: "deferred" },
    ];
    const fakePi = {
      on: (event: string, handler: (event: { systemPromptOptions: BuildSystemPromptOptions }) => void) => {
        if (event === "before_agent_start") handlers.push(handler);
      },
      getAllTools: () => tools,
    } as unknown as Parameters<ExtensionFactory>[0];
    createPromptInheritanceExtension(browserParent, "identity", "/agent")(fakePi);
    const options: BuildSystemPromptOptions = { cwd: "/parent", selectedTools: ["read"] };
    handlers[0]({ systemPromptOptions: options });
    expect(options.sections?.agent_browser).toBe("parent browser guidance");
    expect(options.sections?.subagent_identity).toContain("Directly available tools this round: read.");
    expect(options.sections?.subagent_identity).not.toContain("agent_browser_preview");
    expect(options.sections?.subagent_identity).not.toContain("other_codemode");
  });

  it("does not treat registered but inactive direct tools as callable", () => {
    const handlers: Array<(event: { systemPromptOptions: BuildSystemPromptOptions }) => void> = [];
    const fakePi = {
      on: (event: string, handler: (event: { systemPromptOptions: BuildSystemPromptOptions }) => void) => {
        if (event === "before_agent_start") handlers.push(handler);
      },
      getAllTools: () => [{ name: "agent_browser", exposure: "direct" }],
    } as unknown as Parameters<ExtensionFactory>[0];
    createPromptInheritanceExtension(browserParent, "identity", "/agent")(fakePi);
    const options: BuildSystemPromptOptions = { cwd: "/parent", selectedTools: ["read"] };
    handlers[0]({ systemPromptOptions: options });
    expect(options.sections).not.toHaveProperty("agent_browser");
  });
});
