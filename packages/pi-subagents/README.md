# @yefengr/pi-subagents

[yefengr](https://github.com/yefengr) maintains this [Pi](https://pi.dev) subagent package. It provides an in-process subagent runtime with foreground and background execution, steering, resume, session inspection, lifecycle events, and cross-extension type contracts.

The local baseline comes from `@gotgenes/pi-subagents@19.3.4` and has since evolved independently in this repository. See [`UPSTREAM.md`](./UPSTREAM.md) for the exact source, verification records, import boundaries, and local adaptations. Historical differences from the original project and `tintinweb/pi-subagents` are kept in [Comparison with upstream](./docs/comparison-with-upstream.md).

## Features

- **In-process & native** — agents run inside the same pi runtime (no spawned subprocesses), sharing tool names, calling conventions, and UI patterns (`subagent`, `get_subagent_result`, `steer_subagent`) — feels native
- **Parallel background agents** — spawn multiple agents that run concurrently with automatic queuing (configurable concurrency limit, default 4) and individual completion notifications
- **Live widget UI** — persistent above-editor widget with animated spinners, live tool activity, token counts, and colored status icons
- **Session transcripts** — open any subagent's full session transcript (running or with its session released) in pi's native read-only viewer via `/subagents:sessions`
- **Custom agent types** — define agents in `.pi/agents/<name>.md` with YAML frontmatter: custom system prompts, model selection, thinking levels, tool restrictions
- **Mid-run steering** — inject messages into running agents to redirect their work without restarting
- **Session resume** — pick up where an agent left off, preserving full conversation context
- **Bounded invocations** — strict turn and runtime budgets, a reserved wrap-up window, and independent queue deadlines keep every invocation finite
- **Case-insensitive agent types** — `"explore"`, `"Explore"`, `"EXPLORE"` all work.
  Unknown types fall back to general-purpose with a note
- **Fuzzy model selection** — specify models by name (`"haiku"`, `"sonnet"`) instead of full IDs, with automatic filtering to only available/configured models
- **Context inheritance** — optionally fork the parent conversation into a sub-agent so it knows what's been discussed
- **Styled completion notifications** — background agent results render as themed, compact notification boxes (icon, stats, result preview) instead of raw XML.
  Expandable to show full output
- **Event bus** — lifecycle events (`subagents:created`, `started`, `completed`, `failed`, `resumed`, `steered`, `compacted`) emitted via `pi.events`, enabling other extensions to react to sub-agent activity

## Loading and development

Install from npm:

```bash
pi install npm:@yefengr/pi-subagents
```

Run `/reload` or restart Pi after installation. Other extensions can also depend on this package through `@yefengr/pi-subagents`.

When developing directly in the package directory:

```bash
npm ci
npm run check
npm test
```

You can also load the entry explicitly for a development smoke test:

```bash
pi -e ./index.ts
```

## Quick Start

The parent agent spawns sub-agents using the `subagent` tool:

```text
subagent({
  subagent_type: "Explore",
  prompt: "Find all files that handle authentication",
  description: "Find auth files",
  run_in_background: true,
})
```

Foreground agents block until complete and return results inline. Fresh foreground terminal results include `Agent ID: <id>` so the parent can resume the same agent without a separate lookup.
Background agents return an ID immediately and notify you on completion.

## UI

The extension renders a persistent widget above the editor showing active background agents (foreground runs are rendered inline by the `subagent` tool's progress stream):

```text
● Agents
├─ ⠹ Agent  Refactor auth module · ↻5≤30 · 5 tool uses · 33.8k token (62%) · 12.3s
│    ⎿  editing 2 files…
├─ ⠹ Explore  Find auth files · ↻3 · 3 tool uses · 12.4k token (8%) · 4.1s
│    ⎿  searching…
├─ ⠹ Agent  Long-running task · ↻42 · 38 tool uses · 91.0k token (84% · ⇊2) · 2m17s
│    ⎿  reading…
└─ 2 queued
```

The token field is annotated with two optional signals inside parens:

- **`NN%`** — context-window utilization (color-coded: <70% dim, 70–85% warning, ≥85% error).
  Omitted when the model has no declared `contextWindow`, or briefly right after compaction.
- **`⇊N`** — number of times the session has compacted, when > 0.
  Stays dim; the percent's color carries urgency.

Individual agent results render inline in the conversation:

| Phase / outcome | Example                                                               |
| --------------- | --------------------------------------------------------------------- |
| **Running**     | `⠹ ↻3≤30 · 3 tool uses · 12.4k token (8%)` / `⎿ searching…`         |
| **Completed**   | `✓ ↻8 · 5 tool uses · 33.8k token (62%) · 12.3s` / `⎿ Done`         |
| **Turn limit**  | `✗ ↻30≤30 · 5 tool uses · 33.8k token` / `⎿ Turn limit reached`     |
| **Timed out**   | `✗ ↻3 · 3 tool uses · 12.4k token` / `⎿ Invocation timed out`       |
| **Cancelled**   | `✗ ↻3 · 3 tool uses · 12.4k token` / `⎿ Cancelled`                  |
| **Queue timeout** | `✗` / `⎿ Queue wait timed out before execution`                    |

Completed results can be expanded (ctrl+o in pi) to show the full agent output inline.

Background agent completion notifications render as styled boxes:

```text
✓ Find auth files completed
  ↻3 · 3 tool uses · 12.4k token · 4.1s
  ⎿  Found 5 files related to authentication...
  transcript: .pi/output/agent-abc123.jsonl
```

The LLM receives structured `<task-notification>` XML for parsing, while the user sees the themed visual.

## Tools

### `subagent`

Launch a sub-agent.

| Parameter           | Type         | Required | Description                                                      |
| ------------------- | ------------ | -------- | ---------------------------------------------------------------- |
| `prompt`            | string       | yes      | The task for the agent                                           |
| `description`       | string       | yes      | Short 3-5 word summary (shown in UI)                             |
| `subagent_type`     | string       | yes      | Agent type (built-in or custom)                                  |
| `model`             | string       | no       | Model — `provider/modelId` or fuzzy name (`"haiku"`, `"sonnet"`) |
| `thinking`          | string       | no       | Thinking level: off, minimal, low, medium, high, xhigh           |
| `max_turns`         | integer      | no       | Strict hard maximum for model turns; can only tighten the configured limit |
| `wrap_up_turns`     | integer      | no       | Turns reserved within `max_turns` for a final response; defaults from the profile or global setting |
| `max_duration_seconds` | integer   | no       | Execution-time limit in seconds; can only tighten the configured limit |
| `run_in_background` | boolean      | no       | Run without blocking                                             |
| `resume`            | string       | no       | Agent ID to resume a previous session                            |
| `inherit_context`   | boolean      | no       | Fork parent conversation into agent                              |

### `get_subagent_result`

Check status and retrieve results from a background agent.

| Parameter  | Type    | Required | Description                   |
| ---------- | ------- | -------- | ----------------------------- |
| `agent_id` | string  | yes      | Agent ID to check             |
| `wait`     | boolean | no       | Wait for completion           |
| `verbose`  | boolean | no       | Include full conversation log |

### `steer_subagent`

Send a steering message to a running agent.
The message interrupts after the current tool execution.

| Parameter  | Type   | Required | Description                               |
| ---------- | ------ | -------- | ----------------------------------------- |
| `agent_id` | string | yes      | Agent ID to steer                         |
| `message`  | string | yes      | Message to inject into agent conversation |

## Commands

| Command               | Description                                                                         |
| --------------------- | ----------------------------------------------------------------------------------- |
| `/subagents:settings` | Configure concurrency, resource budgets, retention, and interrupt policy |
| `/subagents:sessions` | View a subagent's session transcript (read-only)                               |

### `/subagents:agents`

List all built-in and custom agent types, including disabled types. Select an agent to inspect its definition and choose whether to enable or disable it in the current project or globally. The reset action removes the selected layer's override: project settings then follow global settings, while global settings return to the default enabled state. Project settings take precedence over global settings. Global agent overrides are stored in the untracked `~/.pi/agent/subagents.local.json`; shared runtime settings remain in `~/.pi/agent/subagents.json`.

### `/subagents:settings`

Interactive list to tune max concurrency, max turns, reserved wrap-up turns, maximum execution duration, maximum queue wait, abort grace, the two session-retention windows, and whether ESC aborts every subagent.
The numeric settings open an input prompt; the abort-on-ESC entry is a direct flip.
Changes persist across pi restarts (see [Persistent Settings](./docs/configuration.md#persistent-settings)).

### `/subagents:sessions`

Pick any subagent — running, or completed with its live session already released — and read its full session transcript in pi's native per-entry viewer.
Read-only: no steering, no session takeover (steering lives in the `steer_subagent` tool and the background widget).

Creating and editing agent definitions is not a command — write an agent `.md` file in your editor, or ask a pi session to generate one (see [Custom Agents](./docs/configuration.md#custom-agents)).

## Resource Limits

Every invocation has finite limits. The defaults are `max_turns: 30`, `wrap_up_turns: 2`, `max_duration_seconds: 1800`, `max_queue_wait_seconds: 900`, and `abort_grace_seconds: 5`.

`max_turns` is a strict hard maximum: the runtime never intentionally starts model turn `max_turns + 1`. `wrap_up_turns` is reserved **within** that maximum, not added to it. When the child still needs another model turn in the reserved window, it receives a final-response instruction; a child with no remaining reserved turns stops at the hard maximum.

Profile and invocation values for `max_turns` and `max_duration_seconds` can only tighten the global ceiling. The effective value is the smallest valid value from global settings, profile frontmatter, and tool call. The wrap-up window uses invocation, then profile, then global precedence and is clamped to `0..max_turns - 1`.

The execution clock starts when a child is admitted to run and includes workspace preparation, session construction, model calls, and tools. Background queue time is excluded from that clock and bounded separately. A queue timeout becomes terminal without starting a child session. On an execution timeout or cancellation, the runtime requests cooperative abort and releases the parent waiter and concurrency slot after `abort_grace_seconds` if the child remains unsettled; tools that ignore `AbortSignal` cannot be forcibly terminated inside this shared process. A terminal cancellation cannot be resumed until its prior turn loop has settled.

## Concurrency

Background agents are subject to a configurable concurrency limit (default: 4).
Excess agents are queued and start as slots free. Each queued agent has an independent maximum wait (default: 900 seconds); when it expires, the agent reaches the `queue_timeout` terminal outcome without executing.
The widget shows queued agents as a collapsed count.

Foreground agents bypass the queue — they block the parent anyway.

Stopping a still-queued agent produces the same completion notification a running agent's stop does.
Because that agent never started, the notification says so and offers no result to collect.

## Child session lifecycle

A child session runs in the parent's process but is a full Pi session with its own extension set.
It receives the standard pair of session lifecycle events:

| Event              | When                                                | Reason      |
| ------------------ | --------------------------------------------------- | ----------- |
| `session_start`    | Extensions are bound, before the child's first turn | `"startup"` |
| `session_shutdown` | The child session is disposed                       | `"quit"`    |

Disposal happens when the retention window for a finished agent expires, when completed records are cleared at session start or switch, when the parent session shuts down, or when child extension binding fails partway.
It does **not** happen the moment an agent finishes: the session is retained so the agent can be resumed, per the `consumedSessionRetentionMinutes` and `unconsumedSessionRetentionMinutes` settings above. The lightweight subagent record retains the child `sessionId` and optional `outputFile` even after the heavy session object is released.

The shutdown event is dispatched and awaited **before** the child's `AgentSession` is disposed, so a handler still has a live context and can close what it opened — stdio subprocesses, sockets, timers, file handles.
Each child's shutdown is bounded: a handler that never resolves is abandoned after a few seconds and disposal proceeds, so one misbehaving extension cannot stall the parent's teardown or Pi's exit.

If you author an extension that runs in children, note that its `session_shutdown` handler now fires **once per child session** in addition to once for the parent.
A handler that flushes a log, writes a summary, or closes a shared resource should be safe to run repeatedly within one process.
Before this behavior existed, children fired `session_start` with no matching shutdown, so extension-owned resources accumulated for the life of the parent process.

## Events

Agent lifecycle events are emitted via `pi.events.emit()` so other extensions can react. Agent events use lifecycle record v3; earlier payload shapes are not supported.

Every v3 payload contains `recordVersion: 3`, agent identity, `phase` (`queued`, `running`, or `terminal`), terminal `outcome` when applicable (`completed`, `turn_limit`, `timeout`, `queue_timeout`, `cancelled`, or `error`), invocation identity (`invocationKind`, `invocationSource`, `invocationIndex`, and tool-driven `toolCallId`), effective resource limits, separate invocation/lifetime turn counts and usage, and explicit session state. `sessionId` is mandatory once a child session exists. `sessionState: "not-created"` is reserved for a pre-session error, queued cancellation, or queue timeout. `outputFile` is optional diagnostic information, not the session attribution key.

| Event                        | When                                                    | Additional fields / behavior                                                                                          |
| ---------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `subagents:created`          | Background agent registered                             | v3 snapshot before limiter admission; not persisted                                                                   |
| `subagents:started`          | Agent enters `running`, including queue admission       | v3 snapshot; not persisted                                                                                             |
| `subagents:completed`        | Fresh invocation reaches `completed`                   | terminal v3 payload; exact same object is persisted as `subagents:record`                                             |
| `subagents:failed`           | Fresh invocation has any non-completed terminal outcome | terminal v3 payload; exact same object is persisted as `subagents:record`                                             |
| `subagents:resumed`          | Resume invocation reaches a terminal outcome            | terminal v3 payload with the current resume `toolCallId`; exact same object is persisted                              |
| `subagents:steered`          | Steering message accepted                               | v3 snapshot plus `instruction`; steering stays inside the current invocation                                          |
| `subagents:compacted`        | Agent's session successfully compacted                  | v3 snapshot plus `reason`, `tokensBefore`, and `compactionCount`                                                      |
| `subagents:settings_loaded`  | Persisted settings applied at extension init            | `settings` (merged global + project)                                                                                   |
| `subagents:settings_changed` | `/subagents:settings` mutation was applied              | `settings`, `persisted` (`boolean`; `false` on write failure)                                                         |

`invocationUsage.total` and `lifetimeUsage.total` equal `input + output + cacheWrite`. `cacheRead` is excluded because each turn reports the cumulative cached prefix re-read on that API call. A fresh run and every resume open a zeroed invocation window while preserving lifetime totals, so prior turns, tools, duration, and usage cannot consume the new invocation's budget.

## Worktree Isolation

Worktree isolation lives in a companion package, not this core.
Install [`@gotgenes/pi-subagents-worktrees`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents-worktrees) and list the agent types you want isolated in its `worktreeAgents` config — opted-in agents run in a temporary git worktree, and their changes are saved to a branch on completion.
The earlier `isolation: "worktree"` spawn flag and `isolation:` frontmatter key were removed from the core.

## Removed: agent memory and skill preloading

Persistent agent memory (the `memory:` frontmatter key) and skill preloading (the `skills:` frontmatter key) were removed when the core was slimmed down.
Children inherit the parent's skills and extensions by default, so the `isolated`, `extensions`, and `skills` frontmatter keys no longer exist.
Package-level extension opt-outs live in the [`excludedExtensionPackages`](./docs/configuration.md#excluding-package-extensions-from-children) setting rather than agent frontmatter.

## Migrating from `disallowed_tools`

The `disallowed_tools` frontmatter field has been removed.
Use [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-permission-system)'s `permission:` frontmatter instead — it provides richer semantics (allow/ask/deny vs. binary hide):

```yaml
# Before (no longer supported)
disallowed_tools: bash

# After
permission:
  bash: deny
```

## Permission System Integration

When [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-permission-system) is installed, this extension integrates automatically:

- **Per-agent permission policies** — define `permission:` in agent YAML frontmatter to set allow/ask/deny rules per agent type.
  The permission system resolves the agent name from the `<active_agent>` tag in the child system prompt.
- **Tool filtering** — the permission system's `before_agent_start` handler removes denied tools from the child session before the agent starts.
- **`ask`-state forwarding** — when a child session triggers an `ask` permission, the prompt forwards to the parent session's UI.
  The parent approves or denies, and the child resumes.
- **Deterministic child detection** — this extension publishes `subagents:child:session-created` before `bindExtensions()` fires; the permission system subscribes and registers the child session synchronously, so detection does not rely on env vars or filesystem heuristics.

No configuration is required.
When `@gotgenes/pi-permission-system` is not installed, the lifecycle events have no subscriber — a harmless no-op.

## For Extension Authors

This package exposes two public subpath exports for companion extensions. `npm pack` verifies that its declarations are independently consumable.

### `@yefengr/pi-subagents` — cross-extension service contract

Access the subagent service from another extension at runtime:

```typescript
const { getSubagentsService } = await import("@yefengr/pi-subagents");
const svc = getSubagentsService();
svc?.spawn("Explore", "Check for stale TODOs");
```

Declare this package as an optional peer dependency.
See `src/service/service.ts` for the full `SubagentsService` interface and the `WorkspaceProvider` seam.

### `@yefengr/pi-subagents/settings` — layered config loader

Extensions that store configuration in JSON files can use the shared layered loader, which reads a global file (`<agentDir>/<filename>`) and a project file (`<cwd>/.pi/<filename>`) and merges them — project wins on conflicts, missing files are silent, malformed files warn and fall back:

```typescript
import { loadLayeredSettings, type LayeredSettingsSource } from "@yefengr/pi-subagents/settings";

interface MyConfig { enabled?: boolean; limit?: number }

function sanitize(raw: unknown): Partial<MyConfig> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<MyConfig> = {};
  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  if (typeof r.limit === "number") out.limit = r.limit;
  return out;
}

const config = loadLayeredSettings<MyConfig>({
  agentDir,          // Pi runtime agent home directory
  cwd,               // project root — project file lives at <cwd>/.pi/<filename>
  filename: "my-extension.json",
  sanitize,
  warnLabel: "my-extension",  // prefix for the malformed-file stderr warning
});
```

`loadLayeredSettings` returns `Partial<T>` (all fields optional); apply your defaults after the call.
It never throws — all error conditions produce a `console.warn` and return `{}`.

## Scope and non-goals

**Purpose.**
A minimal, in-process sub-agent core.
It spawns a child session derived from the parent, runs the turn loop, streams and collects the result, gates concurrency, supports resume, and publishes its lifecycle.
Everything else is a consumer.

**In scope.**
Defects in the surfaces the core already owns, completeness of the public lifecycle-event contract, and internal work toward the minimal-core target.
Anything attaching to the core either subscribes to a lifecycle event, or registers a provider if it must return a value the core consumes — see [ADR-0002](./docs/decisions/0002-extensions-on-a-minimal-core.md).

**Non-goals.**

- _Capability the fork deliberately left behind._
  Scheduling, cross-extension RPC, model-scope enforcement, and a built-in tool denylist belong to upstream — see [Relationship to upstream](#relationship-to-upstream).
- _Policy about what a child may do._
  Tool restriction is allow/ask/deny in a permission layer, not a binary hide in a spawner — see [Migrating from `disallowed_tools`](#migrating-from-disallowed_tools).
- _Widening a child's tool allowlist on the agent's behalf._
  An agent's `tools:` frontmatter is the complete allowlist and the only mechanism that widens it, because a settings-level list would hand a read-only `Explore` agent write-capable tools from a file its author never saw.
- _A global run-mode default._
  Foreground or background is a per-invocation argument and a per-agent frontmatter key; a global flip changes every existing agent file at once.
- _Provider seams with no consumer._
  A seam nobody supplies is a speculative abstraction that taxes every reader; the architecture may admit one without shipping it until a real consumer exists.

The [architecture doc](./docs/architecture/architecture.md#scope-and-non-goals) carries the full inventory, including the removed UI surfaces and the reasoning behind each.

**Where adjacent requests belong.**
Tool restriction and per-agent permission policy → [@gotgenes/pi-permission-system](https://www.npmjs.com/package/@gotgenes/pi-permission-system).
Worktree isolation → [@gotgenes/pi-subagents-worktrees](https://www.npmjs.com/package/@gotgenes/pi-subagents-worktrees).
Timed dispatch, telemetry, and alternate UIs → a consumer over the lifecycle events and the typed service.
A batteries-included alternative → upstream [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents).

## Documentation

| Document                                                       | Contents                                                                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [Configuration](./docs/configuration.md)                       | Default agent types, custom agent files and their frontmatter fields, and the `subagents.json` settings file   |
| [Architecture](./docs/architecture/architecture.md)            | Design principles, domain decomposition, module dependency flow, Mermaid diagrams, and the improvement roadmap |
| [Comparison with upstream](./docs/comparison-with-upstream.md) | Feature-by-feature comparison against the current upstream release                                             |

## Architecture

This extension is a minimal, composable core: it owns agent spawning, execution, and result retrieval, and exposes a typed `SubagentsService` plus lifecycle events that other extensions build on.

## Relationship to upstream

This package starts from the verified `@gotgenes/pi-subagents@19.3.4` source baseline and is maintained independently in this repository. That source was itself a hard fork of [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents). See [`UPSTREAM.md`](./UPSTREAM.md) for the exact tag, commit, integrity evidence and import policy.

The imported comparison and decision documents describe the state of the `19.3.4` baseline. They are retained as design history and must not be treated as a promise to track later third-party releases.

## License

MIT — [tintinweb](https://github.com/tintinweb) (upstream) and [Chris Lasher](https://github.com/gotgenes) (fork)
