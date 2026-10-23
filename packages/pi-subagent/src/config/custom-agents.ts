/**
 * custom-agents.ts — Load user-defined agents from project (.pi/agents/) and global ($PI_CODING_AGENT_DIR/agents/, default ~/.pi/agent/agents/) locations.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES } from "#src/config/agent-types";
import { debugLog } from "#src/debug";
import type { AgentConfig, ThinkingLevel } from "#src/types";

/**
 * Scan for custom agent .md files from multiple locations.
 * Discovery hierarchy (higher priority wins):
 *   1. Project: <cwd>/.pi/agents/*.md
 *   2. Global:  $PI_CODING_AGENT_DIR/agents/*.md (default: ~/.pi/agent/agents/*.md)
 *
 * Project-level agents override global ones with the same name.
 * Any name is allowed — names matching defaults (e.g. "Explore") override them.
 */
export function loadCustomAgents(cwd: string): Map<string, AgentConfig> {
  const globalDir = join(getAgentDir(), "agents");
  const projectDir = join(cwd, ".pi", "agents");

  const agents = new Map<string, AgentConfig>();
  loadFromDir(globalDir, agents, "global");   // lower priority
  loadFromDir(projectDir, agents, "project");  // higher priority (overwrites)
  return agents;
}

/** Load agent configs from a directory into the map. */
function loadFromDir(dir: string, agents: Map<string, AgentConfig>, source: "project" | "global"): void {
  if (!existsSync(dir)) return;

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".md"));
  } catch (err) {
    debugLog("readdirSync agents dir", err);
    return;
  }

  for (const file of files) {
    const name = basename(file, ".md");

    let content: string;
    try {
      content = readFileSync(join(dir, file), "utf-8");
    } catch (err) {
      debugLog("readFileSync agent file", err);
      continue;
    }

    const { frontmatter: fm, body } = parseFrontmatter(content);

    agents.set(name, {
      name,
      displayName: str(fm.display_name),
      description: str(fm.description) ?? name,
      toolNames: listField(fm.tools, BUILTIN_TOOL_NAMES),
      model: str(fm.model),
      thinking: str(fm.thinking) as ThinkingLevel | undefined,
      maxTurns: intAtLeast(fm.max_turns, 1),
      wrapUpTurns: intAtLeast(fm.wrap_up_turns, 0),
      maxDurationSeconds: intAtLeast(fm.max_duration_seconds, 1),
      systemPrompt: body.trim(),
      promptMode: fm.prompt_mode === "replace" ? "replace" : "append",
      inheritContext: fm.inherit_context != null ? fm.inherit_context === true : undefined,
      runInBackground: fm.run_in_background != null ? fm.run_in_background === true : undefined,
      source,
      filePath: join(dir, file),
    });
  }
}

// ---- Field parsers ----
// All follow the same convention: omitted → default, "none"/empty → nothing, value → exact.

/** Extract a string or undefined. */
function str(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}

/** Extract an integer at or above `min`, or undefined. 0 is not a special value. */
function intAtLeast(val: unknown, min: number): number | undefined {
  return typeof val === "number" && Number.isInteger(val) && val >= min ? val : undefined;
}

/**
 * Parse a raw list field into items, or undefined if absent/empty/"none".
 *
 * Frontmatter is YAML, so a list field is written either as a comma-separated
 * scalar (`tools: read, grep`) or as a sequence (`tools: [read, grep]`). Both
 * are supported: a sequence keeps its entries intact, while a scalar is split
 * on commas.
 */
function parseListField(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  const items = Array.isArray(val)
    ? val.map(entry => String(entry).trim()).filter(Boolean)
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- val is already narrowed past null/undefined; String() is the intended coercion here
    : String(val).trim().split(",").map(entry => entry.trim()).filter(Boolean);
  if (items.length === 0) return undefined;
  return items.length === 1 && items[0] === "none" ? undefined : items;
}

/**
 * Parse a list field with defaults.
 * omitted → defaults; "none"/empty → []; otherwise → listed items.
 */
function listField(val: unknown, defaults: string[]): string[] {
  if (val === undefined || val === null) return defaults;
  return parseListField(val) ?? [];
}
