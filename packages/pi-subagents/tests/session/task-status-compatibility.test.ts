import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentSession, type BuildSystemPromptOptions, createAgentSession, DefaultResourceLoader,
  type ExtensionFactory, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createExcludedPackagesStorage } from "#src/session/package-exclusions";
import { createPromptInheritanceExtension } from "#src/session/prompt-inheritance";
import { makeModel } from "#test/helpers/make-model";
import taskStatus from "../../../pi-task-status/src/extension.ts";
import { TASK_STATUS_INSTRUCTIONS, TOOL_NAME } from "../../../pi-task-status/src/instructions.ts";

const taskStatusSource = fileURLToPath(new URL("../../../pi-task-status/src/extension.ts", import.meta.url));

async function createHost(
  cwd: string, agentDir: string, settings: SettingsManager, factories: ExtensionFactory[], tools: string[], noExtensions: boolean,
) {
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager: settings, extensionFactories: factories, noExtensions,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false, allowModelNetwork: false,
  });
  const { session } = await createAgentSession({
    cwd, agentDir, settingsManager: settings, resourceLoader: loader, modelRuntime: runtime,
    model: makeModel(), sessionManager: SessionManager.inMemory(cwd), tools,
  });
  try {
    await session.bindExtensions({});
    return { session, loader };
  } catch (error) {
    session.dispose();
    throw error;
  }
}

async function runPrompt(session: AgentSession, options?: BuildSystemPromptOptions) {
  return (await session.extensionRunner.emitBeforeAgentStart(
    { messageType: "user", prompt: "inspect only" },
    options ?? session.extensionRunner.createCommandContext().getSystemPromptOptions(),
  )).systemPromptOptions;
}

function expectNoTaskGuidance(options: BuildSystemPromptOptions) {
  expect(options.forceSystemPrompt).toBeUndefined();
  expect(options.sections).not.toHaveProperty("task_status");
  expect(options.selectedTools).not.toContain(TOOL_NAME);
  expect(options.toolSnippets).not.toHaveProperty(TOOL_NAME);
  expect(options.toolGuidelines).not.toHaveProperty(TOOL_NAME);
  expect(JSON.stringify(options)).not.toContain(TASK_STATUS_INSTRUCTIONS);
}

describe("Task Status and Subagents SDK composition", () => {
  it.each([false, true])("excludes package loading and inherited guidance (cross cwd: %s)", async (crossCwd) => {
    const root = mkdtempSync(join(tmpdir(), "task-status-sdk-"));
    const agentDir = join(root, "agent");
    const parentCwd = join(root, "parent");
    const childCwd = crossCwd ? join(root, "child") : parentCwd;
    const packageDir = join(root, "task-status-package");
    const auditFile = join(root, "package-audit.jsonl");
    const sessions: AgentSession[] = [];
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden in SDK composition regression"); });
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      for (const directory of new Set([agentDir, parentCwd, childCwd, packageDir])) mkdirSync(directory, { recursive: true });
      writeFileSync(auditFile, "");
      writeFileSync(join(packageDir, "package.json"), JSON.stringify({
        name: "isolated-task-status", type: "module", pi: { extensions: ["./index.ts"] },
      }));
      // Audit wraps the real factory, so filtering must prevent both import and registration.
      writeFileSync(join(packageDir, "index.ts"), [
        'import { appendFileSync } from "node:fs";',
        `import taskStatus from ${JSON.stringify(taskStatusSource)};`,
        `const audit = (stage) => appendFileSync(${JSON.stringify(auditFile)}, stage + "\\n");`,
        'audit("import");',
        'export default (pi) => { audit("factory"); taskStatus(pi); };',
      ].join("\n"));
      const settings = SettingsManager.inMemory({ packages: [packageDir] }, { projectTrusted: false });
      const settingsBefore = structuredClone(settings.getGlobalSettings());
      const parent = await createHost(parentCwd, agentDir, settings, [taskStatus], ["read", TOOL_NAME], true);
      sessions.push(parent.session);
      expect(parent.session.getAllTools().map((tool) => tool.name)).toContain(TOOL_NAME);
      const base = parent.session.extensionRunner.createCommandContext().getSystemPromptOptions();
      const parentOptions = await runPrompt(parent.session, {
        ...base, sections: { operator: "keep user section" }, promptGuidelines: ["keep user guideline"],
      });
      expect(parentOptions.forceSystemPrompt).toBeUndefined();
      expect(parentOptions.sections.task_status).toBe(TASK_STATUS_INSTRUCTIONS);
      expect((await runPrompt(parent.session, parentOptions)).sections).toEqual(parentOptions.sections);
      const frozenParent = structuredClone(parentOptions);

      const excludedSettings = SettingsManager.fromStorage(createExcludedPackagesStorage(settings, new Set([packageDir])));
      const excluded = await createHost(childCwd, agentDir, excludedSettings, [
        createPromptInheritanceExtension(parentOptions, "excluded child", agentDir),
      ], ["read"], false);
      sessions.push(excluded.session);
      const errors: unknown[] = [];
      excluded.session.extensionRunner.onError((error) => errors.push(error));
      const childBase = excluded.session.extensionRunner.createCommandContext().getSystemPromptOptions();
      const childOptions = await runPrompt(excluded.session);
      expect(errors).toEqual([]);
      expect(readFileSync(auditFile, "utf8")).toBe("");
      expect(excluded.loader.getExtensions().extensions.map((extension) => extension.path)).not.toContain(join(packageDir, "index.ts"));
      expect(excluded.session.getAllTools().map((tool) => tool.name)).not.toContain(TOOL_NAME);
      expect(excluded.session.getActiveToolNames()).toEqual(["read"]);
      expectNoTaskGuidance(childOptions);
      expect(childOptions.sections).toMatchObject({ operator: "keep user section" });
      expect(childOptions.sections?.subagent_identity).toMatch(/^excluded child\n\nDirectly available tools this round: read\./);
      expect(childOptions.promptGuidelines).toEqual(["keep user guideline"]);
      expect(childOptions.toolSnippets).toEqual(childBase.toolSnippets);
      expect(childOptions.toolGuidelines).toEqual(childBase.toolGuidelines);
      expect(parentOptions).toEqual(frozenParent);
      expect(settings.getGlobalSettings()).toEqual(settingsBefore);

      // Positive control: the same package source imports and registers the real tool when enabled.
      const included = await createHost(childCwd, agentDir, settings, [
        createPromptInheritanceExtension(parentOptions, "included child", agentDir),
      ], ["read", TOOL_NAME], false);
      sessions.push(included.session);
      const includedOptions = await runPrompt(included.session);
      expect(readFileSync(auditFile, "utf8").split("\n")).toContain("import");
      expect(readFileSync(auditFile, "utf8").split("\n")).toContain("factory");
      expect(included.session.getAllTools().map((tool) => tool.name)).toContain(TOOL_NAME);
      expect(includedOptions.sections.task_status).toBe(TASK_STATUS_INSTRUCTIONS);
      expect(includedOptions.forceSystemPrompt).toBeUndefined();
      expect(parentOptions).toEqual(frozenParent);
      expect(settings.getGlobalSettings()).toEqual(settingsBefore);
      expect(network).not.toHaveBeenCalled();
    } finally {
      for (const session of sessions.reverse()) session.dispose();
      vi.unstubAllEnvs();
      network.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
