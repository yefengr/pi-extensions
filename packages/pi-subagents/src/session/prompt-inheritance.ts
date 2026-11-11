import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
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
  const sections = { ...parent.sections, ...child.sections };
  // Explicit custom sections are user text, including sections named tools/rules/cwd.
  sections.subagent_identity = identity.trim();
  return {
    ...structuredClone(child),
    customPrompt: parent.customPrompt,
    appendSystemPrompt: mergePromptAddenda(parent.appendSystemPrompt, child.appendSystemPrompt, childAppendSources),
    promptGuidelines: [...new Set([...(parent.promptGuidelines ?? []), ...(child.promptGuidelines ?? [])])],
    sections,
    contextFiles: [...files.values()],
  };
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

/** Loaded last so other child extensions can supply their current tool/resource metadata. */
export function createPromptInheritanceExtension(
  parent: BuildSystemPromptOptions,
  identity: string,
  agentDir: string,
  readChildAppendSources: () => readonly string[] = () => [],
): ExtensionFactory {
  const frozen = structuredClone(parent);
  return (pi) => {
    pi.on("before_agent_start", (event) => {
      const inherited = inheritPromptOptions(frozen, event.systemPromptOptions, identity, agentDir, readChildAppendSources());
      Object.assign(event.systemPromptOptions, inherited);
    });
  };
}
