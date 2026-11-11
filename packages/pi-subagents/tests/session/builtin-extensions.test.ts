import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { assertDeclaredTools, selectBuiltinExtensions } from "#src/session/builtin-extensions";
import { createPromptInheritanceExtension } from "#src/session/prompt-inheritance";
import { makeModel } from "#test/helpers/make-model";

function selectedNames(tools: string[], policy = {}) {
  return selectBuiltinExtensions(tools, policy).map((entry) => typeof entry === "function" ? "inline" : entry.name);
}

describe("SDK builtin selection", () => {
  it("selects only necessary factories and keeps named native exclusion semantics", () => {
    expect(selectedNames(["read"])).toEqual([]);
    expect(selectedNames(["codemode"])).toEqual(["codemode"]);
    expect(selectedNames(["tool_search", "mcp__docs__read"])).toEqual(["tool-search", "mcp"]);
    expect(selectedNames(["codemode"], { availableTools: ["codemode", "mcp__docs__read"] })).toEqual(["codemode", "mcp"]);
    expect(selectedNames(["codemode"], { availableTools: ["read"] })).toEqual([]);
    expect(selectedNames(["codemode"], { noExtensions: true })).toEqual([]);
    expect(selectedNames(["codemode", "tool_search"], { disabledBuiltinExtensions: ["codemode"] })).toEqual(["tool-search"]);
  });

  it("reports missing declared tools and supports exact-name wildcard patterns", () => {
    expect(() => assertDeclaredTools(["read", "mcp__docs__*"], ["read", "mcp__docs__search"])).not.toThrow();
    expect(() => assertDeclaredTools(["a.b"], ["axb"])).toThrow("a.b");
    expect(() => assertDeclaredTools(["read"], ["read", "write"])).toThrow("exceed the declared allowlist");
    expect(() => assertDeclaredTools(["tool_search"], ["read"])).toThrow("tool_search");
  });

  it.each([
    { label: "native settings exclusion", noExtensions: false, disabledBuiltinExtensions: [] as string[], expectCodemode: true },
    { label: "noExtensions", noExtensions: true, disabledBuiltinExtensions: [] as string[], expectCodemode: false },
    { label: "disabled built-in", noExtensions: false, disabledBuiltinExtensions: ["codemode"], expectCodemode: false },
  ])("binds SDK factories under $label without network or global credentials", async ({ noExtensions, disabledBuiltinExtensions, expectCodemode }) => {
    const root = mkdtempSync(join(tmpdir(), "subagents-sdk-"));
    const agentDir = join(root, "agent");
    const settings = SettingsManager.inMemory({ extensions: ["-builtin:tool-search"] }, { projectTrusted: false });
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir, settingsManager: settings,
      noExtensions, disabledBuiltinExtensions,
      noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
      extensionFactories: [
        ...selectBuiltinExtensions(["codemode", "tool_search"]),
        createPromptInheritanceExtension({ cwd: root, sections: { operator: "stable custom section" } }, "child identity", agentDir),
      ],
    });
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await loader.reload();
      const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json") });
      ({ session } = await createAgentSession({
        cwd: root, agentDir, settingsManager: settings, resourceLoader: loader,
        modelRuntime: runtime, model: makeModel(), sessionManager: SessionManager.inMemory(root),
        tools: ["read", "codemode", "tool_search"], excludeTools: ["subagent", "get_subagent_result", "steer_subagent"],
      }));
      await session.bindExtensions({});
      const registered = session.getAllTools().map((tool) => tool.name);
      expect(registered.includes("codemode")).toBe(expectCodemode);
      // Native codemode registers inactive; only actual declared tools are activated.
      session.setActiveToolsByName(["read", ...(expectCodemode ? ["codemode"] : [])]);
      const actual = [...new Set([...session.getActiveToolNames(), ...session.getCallableToolNames()])];
      expect(actual.includes("codemode")).toBe(expectCodemode);
      assertDeclaredTools(["read", ...(expectCodemode ? ["codemode"] : [])], actual);
      expect(actual).not.toContain("tool_search");
      expect(() => assertDeclaredTools(["tool_search"], actual)).toThrow("tool_search");
      expect(loader.getExtensions().errors).toEqual([]);
    } finally {
      session?.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
