import { BUILTIN_TOOL_NAMES } from "#src/config/agent-types";

/** Deliberately finite: an unfamiliar name never becomes a broader capability. */
const TOOL_ALIASES: Readonly<Record<string, string>> = {
  read_file: "read",
  write_file: "write",
  edit_file: "edit",
  shell: "bash",
  glob: "find",
};

/** Resolve before SDK admission; exact registered names always win over aliases. */
export function normalizeToolNames(names: readonly string[], available: readonly string[] = []): string[] {
  const known = [...new Set([...BUILTIN_TOOL_NAMES, "codemode", "tool_search", ...available])];
  return [...new Set(names.map((name) => resolveToolName(name.trim(), known)))];
}

function resolveToolName(name: string, known: readonly string[]): string {
  if (!name) throw new Error("Subagent tool names cannot be empty");
  if (known.includes(name)) return name;
  if (name.includes("*")) return resolvePattern(name, known);
  const matches = known.filter((candidate) => candidate.toLowerCase() === name.toLowerCase());
  if (matches.length > 1) throw new Error(`Ambiguous subagent tool name "${name}": ${matches.join(", ")}; use an exact registered name`);
  if (matches.length === 1) return matches[0]!;
  const key = name.toLowerCase();
  return Object.hasOwn(TOOL_ALIASES, key) ? TOOL_ALIASES[key]! : name;
}

function resolvePattern(pattern: string, known: readonly string[]): string {
  const parts = pattern.split("*").map((part) => `(${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`);
  const matcher = new RegExp(`^${parts.join(".*?")}$`, "i");
  const spellings = new Set(known.flatMap((name) => {
    const match = matcher.exec(name);
    return match ? [match.slice(1).join("*")] : [];
  }));
  if (spellings.size > 1) throw new Error(`Ambiguous subagent tool pattern "${pattern}"; use exact registered names`);
  // Child-only extension tools may not be present in the parent. Preserve exact
  // declarations and let the post-binding check report a genuine zero match.
  return spellings.values().next().value ?? pattern;
}
