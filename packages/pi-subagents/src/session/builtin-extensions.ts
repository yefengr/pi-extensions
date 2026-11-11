import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

export interface BuiltinExtensionPolicy {
  availableTools?: readonly string[];
  noExtensions?: boolean;
  disabledBuiltinExtensions?: readonly string[];
}

/** Select only the public SDK factories needed by the declared child tools. */
export function selectBuiltinExtensions(
  toolNames: readonly string[],
  policy: BuiltinExtensionPolicy = {},
): InlineExtension[] {
  if (policy.noExtensions) return [];
  const available = policy.availableTools;
  const wants = (name: string) => toolNames.some((pattern) => matchesTool(pattern, name));
  const canUse = (name: string) => !available || available.includes(name);
  const selected: InlineExtension[] = [];
  const add = (name: string, factory: () => ReturnType<typeof createCodemodeExtension>) => {
    if (!policy.disabledBuiltinExtensions?.includes(name)) {
      selected.push({ name, factory: factory(), builtin: true, replaceable: true });
    }
  };
  if (wants("codemode") && canUse("codemode")) add("codemode", createCodemodeExtension);
  if (wants("tool_search") && canUse("tool_search")) add("tool-search", createToolSearchExtension);
  const mcpTools = available?.filter((name) => name.startsWith("mcp__"));
  const wantsMcp = toolNames.some((name) => name.startsWith("mcp__")) ||
    (!!mcpTools?.length && (wants("codemode") || wants("tool_search")));
  if (wantsMcp && (!available || mcpTools?.length)) add("mcp", createMcpExtension);
  return selected;
}

export function matchesTool(pattern: string, name: string): boolean {
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`).test(name);
}

/** Exact declarations fail closed when extension loading did not provide them. */
export function assertDeclaredTools(toolNames: readonly string[], actualNames: readonly string[]): void {
  const missing = toolNames.filter((pattern) => !actualNames.some((name) => matchesTool(pattern, name)));
  if (missing.length) throw new Error(`Subagent tools are unavailable after extension binding: ${missing.join(", ")}. Check exact tool names, supported aliases, disabled extensions and package exclusions.`);
  const unexpected = actualNames.filter((name) => !toolNames.some((pattern) => matchesTool(pattern, name)));
  if (unexpected.length) throw new Error(`Subagent callable tools exceed the declared allowlist: ${unexpected.join(", ")}`);
}
