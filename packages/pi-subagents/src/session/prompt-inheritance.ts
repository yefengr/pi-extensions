import { isAbsolute, relative, resolve, sep } from "node:path";
import { getCurrentSystemMessage, getCurrentTools } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  BuildSystemPromptOptions,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

/** Rebuild through the SDK's normal renderer; rendered parent text is never parsed. */
export function inheritPromptOptions(
  parent: BuildSystemPromptOptions,
  child: BuildSystemPromptOptions,
  identity: string,
  agentDir: string,
  childAppendSources: readonly string[] = [],
  indirectCallableTools: readonly string[] = [],
): BuildSystemPromptOptions {
  if (parent.forceSystemPrompt !== undefined) {
    throw new Error("Cannot inherit an opaque forceSystemPrompt");
  }
  const sameCwd = resolve(parent.cwd) === resolve(child.cwd);
  // The SDK options flatten APPEND sources into text. Different addenda across
  // projects cannot be assigned a reliable scope without their source metadata.
  if (!sameCwd && parent.appendSystemPrompt && parent.appendSystemPrompt !== child.appendSystemPrompt) {
    throw new Error("Cannot inherit cross-directory APPEND instructions without verified source metadata");
  }
  const inheritedFiles = (parent.contextFiles ?? []).filter((file) =>
    sameCwd || isWithin(agentDir, file.path),
  );
  const files = new Map(
    [...inheritedFiles, ...(child.contextFiles ?? [])].map((file) => [resolve(file.path), { ...file }]),
  );
  const sections = filterToolSections(
    { ...parent.sections, ...child.sections }, child.selectedTools ?? [],
    [...(child.selectedTools ?? []), ...indirectCallableTools],
  );
  // Explicit custom sections are user text, including sections named tools/rules/cwd.
  const hidden = new Set(child.hiddenTools ?? []);
  sections.subagent_identity = appendToolAvailability(identity.trim(), child.selectedTools?.filter((name) => !hidden.has(name)));
  return {
    ...structuredClone(child),
    customPrompt: parent.customPrompt,
    appendSystemPrompt: mergePromptAddenda(parent.appendSystemPrompt, child.appendSystemPrompt, childAppendSources),
    promptGuidelines: [...new Set([...(parent.promptGuidelines ?? []), ...(child.promptGuidelines ?? [])])],
    sections,
    contextFiles: [...files.values()],
  };
}

function isBrowserTool(name: string): boolean {
  return name === "agent_browser" || name.startsWith("agent_browser_");
}

function filterToolSections(
  source: Record<string, string>, taskTools: readonly string[], browserTools: readonly string[],
): Record<string, string> {
  const sections = { ...source };
  if (!taskTools.includes("update_task_status")) delete sections.task_status;
  if (!browserTools.some(isBrowserTool)) delete sections.agent_browser;
  return sections;
}

/** State the child's direct tools without granting access or hiding inherited text. */
function appendToolAvailability(identity: string, visibleTools: readonly string[] | undefined): string {
  const lines: string[] = [];
  if (visibleTools === undefined) {
    lines.push("Directly available tools are not declared in this session's prompt metadata.");
  } else {
    const visible = [...new Set(visibleTools)].sort();
    lines.push(`Directly available tools this round: ${visible.length > 0 ? visible.join(", ") : "none"}.`);
  }
  lines.push(
    "Tool names mentioned in instructions or inherited text do not grant access; only the tools provided to this session can be used.",
    "If the task needs a capability this session does not have, report the specific need or findings to the parent agent.",
  );
  return [identity, lines.join("\n")].filter(Boolean).join("\n\n");
}

function isWithin(root: string, path: string): boolean {
  const remainder = relative(resolve(root), resolve(path));
  return remainder === "" || (!isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`));
}

/** Deduplicate known resource bodies without splitting or interpreting arbitrary prompt text. */
export function mergePromptAddenda(
  parent: string | undefined,
  child: string | undefined,
  childSources: readonly string[] = [],
): string {
  let inherited = parent ?? "";
  const current = child ?? "";
  if (inherited === current) return current;
  for (const source of childSources) {
    if (!source || !current.includes(source)) continue;
    let offset = inherited.indexOf(source);
    while (offset >= 0) {
      const end = offset + source.length;
      const before = inherited.slice(0, offset);
      const after = inherited.slice(end);
      if ((!before || before.endsWith("\n\n")) && (!after || after.startsWith("\n\n"))) {
        inherited = before && after ? before + after.slice(2) : (before || after).replace(/^\n\n|\n\n$/g, "");
        break;
      }
      offset = inherited.indexOf(source, offset + 1);
    }
  }
  return [inherited, current].filter(Boolean).join("\n\n");
}

type PromptMessages = AgentSession["agent"]["state"]["messages"];
export type ToolPromptSync = (
  messages: PromptMessages, callableTools: readonly string[], activeTools: readonly string[],
) => PromptMessages;

const TOOL_PROMPT_SECTIONS = ["task_status", "agent_browser", "subagent_identity"] as const;

/** Project only our named sections; preserve transcript order, text, and tool deltas. */
function syncToolPrompt(
  messages: PromptMessages, source: Record<string, string>, identity: string,
  callableTools: readonly string[], activeTools: readonly string[],
): PromptMessages {
  const head = messages[0];
  const current = getCurrentSystemMessage(messages);
  // Forced/opaque or replaced context has no reliable structured identity metadata.
  if (head?.role !== "system" || !head.sections || !current?.sections?.subagent_identity) return messages;
  const visibleTools = getCurrentTools(messages).map((tool) => tool.name);
  const sections = filterToolSections(source, activeTools, [...visibleTools, ...callableTools]);
  sections.subagent_identity = appendToolAvailability(identity.trim(), visibleTools);
  const desired = Object.fromEntries(Object.entries(sections)
    .filter(([, body]) => !!body).map(([name, body]) => [name, `<${name}>\n${body}\n</${name}>`]));
  let changed = false;
  const projected = messages.map((message, index) => {
    if (message.role !== "system") return message;
    if (TOOL_PROMPT_SECTIONS.every((key) => index === 0
      ? message.sections?.[key] === desired[key]
      : !Object.hasOwn(message.sections ?? {}, key))) return message;
    const next = { ...message.sections };
    for (const key of TOOL_PROMPT_SECTIONS) delete next[key];
    if (index === 0) Object.assign(next, desired);
    changed = true;
    return { ...message, sections: next };
  });
  return changed ? projected : messages;
}

/** Loaded last so other child extensions can supply their current tool/resource metadata. */
export function createPromptInheritanceExtension(
  parent: BuildSystemPromptOptions,
  identity: string,
  agentDir: string,
  readChildAppendSources: () => readonly string[] = () => [],
  bindToolPromptSync?: (sync: ToolPromptSync) => void,
): ExtensionFactory {
  const frozen = structuredClone(parent);
  return (pi) => {
    let source: Record<string, string> | undefined;
    bindToolPromptSync?.((messages, callableTools, activeTools) => source
      ? syncToolPrompt(messages, source, identity, callableTools, activeTools) : messages);
    pi.on("before_agent_start", (event) => {
      // Capture before filtering, including the child's current body for re-enabling tools.
      const merged = { ...frozen.sections, ...event.systemPromptOptions.sections };
      source = Object.fromEntries(["task_status", "agent_browser"]
        .flatMap((key) => merged[key] === undefined ? [] : [[key, merged[key]]]));
      // `getAllTools()` is already filtered by the SDK's allow/deny policy, but only
      // codemode/deferred entries are callable without being directly declared.
      const indirectCallableTools = pi.getAllTools()
        .filter((tool) => tool.exposure === "codemode" || tool.exposure === "deferred")
        .map((tool) => tool.name);
      const inherited = inheritPromptOptions(
        frozen, event.systemPromptOptions, identity, agentDir, readChildAppendSources(), indirectCallableTools,
      );
      Object.assign(event.systemPromptOptions, inherited);
    });
  };
}
