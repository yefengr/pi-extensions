/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are always available but can be overridden by user .md files with the same name.
 * Custom agents can join the default list with `is_default: true` in their frontmatter.
 */

import type { AgentConfig } from "#src/types";

export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map([
  [
    "general-purpose",
    {
      name: "general-purpose",
      displayName: "Agent",
      description: "General-purpose agent for complex, multi-step tasks",
      toolGuideline: "- Use general-purpose for complex tasks that need file editing.",
      // toolNames omitted — means "all available tools" (resolved at lookup time)
      // inheritContext / runInBackground omitted — strategy fields, callers decide per-call.
      // Setting them to false would lock callsite intent (see resolveAgentInvocationConfig in invocation-config.ts).
      systemPrompt: "",
      promptMode: "append",
      isDefault: true,
    },
  ],
]);
