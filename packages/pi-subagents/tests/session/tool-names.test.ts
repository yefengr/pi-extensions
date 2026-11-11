import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSession, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { assertDeclaredTools, matchesTool, selectBuiltinExtensions } from "#src/session/builtin-extensions";
import { normalizeToolNames } from "#src/session/tool-names";
import { makeModel } from "#test/helpers/make-model";

describe("bounded tool-name compatibility", () => {
  it("normalizes built-in case and only the documented aliases, deduplicating targets", () => {
    expect(normalizeToolNames(["Read", "read_file", "WRITE_FILE", "Edit_File", "Shell", "Glob", "GREP", "LS"]))
      .toEqual(["read", "write", "edit", "bash", "find", "grep", "ls"]);
  });

  it("prefers an exact registered tool over a built-in alias", () => {
    expect(normalizeToolNames(["Shell"], ["Shell"])).toEqual(["Shell"]);
  });

  it("resolves unique extension names to their actual registered spelling", () => {
    expect(normalizeToolNames(["AGENT_BROWSER", "MCP__FILES__READ"], ["agent_browser", "mcp__files__read"]))
      .toEqual(["agent_browser", "mcp__files__read"]);
  });

  it("rejects ambiguous case without choosing or admitting both capabilities", () => {
    expect(() => normalizeToolNames(["FETCH"], ["Fetch", "fetch"])).toThrow("Ambiguous");
    expect(normalizeToolNames(["Fetch"], ["Fetch", "fetch"])).toEqual(["Fetch"]);
  });

  it("canonicalizes a wildcard's literal spelling while retaining its bounded pattern", () => {
    const tools = normalizeToolNames(["MCP__FILES__*"], ["mcp__files__read", "mcp__files__write"]);
    expect(tools).toEqual(["mcp__files__*"]);
    expect(matchesTool(tools[0]!, "mcp__files__read")).toBe(true);
    expect(matchesTool(tools[0]!, "mcp__other__read")).toBe(false);
    expect(normalizeToolNames(["*"])).toEqual(["*"]);
  });

  it("rejects wildcard case ambiguity and escapes regex punctuation literally", () => {
    expect(() => normalizeToolNames(["FETCH*"], ["FetchFile", "fetchOther"])).toThrow("Ambiguous");
    expect(normalizeToolNames(["FOO.BAR*"], ["foo.barThing", "fooxbarThing"]))
      .toEqual(["foo.bar*"]);
  });

  it("preserves unknown names for a clear post-binding refusal rather than broadening access", () => {
    for (const name of ["TypoTool", "unknown*", "constructor", "__proto__"]) {
      const tools = normalizeToolNames([name]);
      expect(tools).toEqual([name]);
      expect(() => assertDeclaredTools(tools, ["read"])).toThrow("Check exact tool names");
    }
    expect(() => normalizeToolNames([" "])).toThrow("cannot be empty");
  });

  it("admits normalized aliases through the actual SDK without a model request", async () => {
    const root = mkdtempSync(join(tmpdir(), "subagent-tool-names-"));
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden in tool-name smoke"); });
    let session: AgentSession | undefined;
    try {
      const settings = SettingsManager.inMemory();
      const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await loader.reload();
      const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"),
        refreshOnCreate: false, allowModelNetwork: false });
      ({ session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime,
        model: makeModel(), sessionManager: SessionManager.inMemory(root), resourceLoader: loader,
        settingsManager: settings, tools: normalizeToolNames(["Read", "Shell", "Glob"]) }));
      await session.bindExtensions({});
      expect(session.getActiveToolNames().sort()).toEqual(["bash", "find", "read"]);
      expect(network).not.toHaveBeenCalled();
    } finally {
      session?.dispose();
      network.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps capability exclusions and SDK built-in disable policy effective", () => {
    const tools = normalizeToolNames(["CODEMODE"]);
    expect(tools).toEqual(["codemode"]);
    expect(selectBuiltinExtensions(tools, { disabledBuiltinExtensions: ["codemode"] })).toEqual([]);
    expect(() => assertDeclaredTools(tools, ["read"])).toThrow("unavailable");
    expect(normalizeToolNames(["Subagent"], ["subagent"])).toEqual(["subagent"]);
  });
});
