import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { inheritPromptOptions, mergePromptAddenda } from "#src/session/prompt-inheritance";

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
    expect(result.sections).toEqual({ operator: "keep exact custom section", cwd: "stale cwd", subagent_identity: "<active_agent name=\"child\"/>" });
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
    expect(result.sections).toEqual({ ...parent.sections, child: "child section", subagent_identity: "identity" });
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
