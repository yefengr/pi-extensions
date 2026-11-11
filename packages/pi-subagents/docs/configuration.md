# Configuration

`@yefengr/pi-subagents` has two configuration surfaces: **agent definition files** that describe an agent type, and a **`subagents.json`** settings file that tunes the runtime.
Neither is required — every field has a default.

For the tools, commands, events, and service API, see the [README](../README.md).

## Default Agent Types

| Type              | Tools                      | Model                         | Prompt Mode            | Description                                                                                      |
| ----------------- | -------------------------- | ----------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| `general-purpose` | all 7                      | inherit                       | `append` (parent twin) | Inherits parent identity and user rules; tools and project resources describe the child environment |

The `general-purpose` agent inherits the parent's identity and shared rules plus a sub-agent context bridge. Pi regenerates tool instructions, skills, working-directory information, and applicable project context for the child.
It is also the fallback target for unknown agent types; a disabled known type still fails instead of bypassing its enablement setting.

An agent configured with `prompt_mode: replace` preserves the inherited identity and places specialist instructions last, without the bridge or `<agent_instructions>` wrapper. Profile model and thinking settings take precedence over tool or service parameters; unspecified thinking inherits the parent's value captured at dispatch.

Prompt inheritance uses the SDK's structured construction options rather than cutting sections out of rendered text. Explicit user sections retain their contents even when named `tools`, `rules`, or `cwd`. Changing directories reloads the target project's context files and resource paths; user-level rules are deduplicated by path. An opaque forced prompt, a stale structured snapshot, or cross-directory APPEND text whose scope cannot be verified causes an explicit error instead of silently dropping instructions. There is no byte-identical parent-prefix guarantee.

Target directories use their own existing project-trust decision. Trust in the parent project does not grant trust to another project.

Default agents can be **overridden** by creating a `.md` file with the same name (e.g. `.pi/agents/general-purpose.md`). Enablement is managed by `/subagents:agents` and stored per project or globally in `subagents.json`.
A custom agent joins the default list with `is_default: true`; its `tool_guideline` then becomes a one-line hint in the `subagent` tool description.

## Custom Agents

Define custom agent types by creating `.md` files.
The filename becomes the agent type name.
Any name is allowed — using a default agent's name overrides it.

Agents are discovered from two locations (higher priority wins):

| Priority    | Location                                                                         | Scope                         |
| ----------- | -------------------------------------------------------------------------------- | ----------------------------- |
| 1 (highest) | `.pi/agents/<name>.md`                                                           | Project — per-repo agents     |
| 2           | `$PI_CODING_AGENT_DIR/agents/<name>.md` (default `~/.pi/agent/agents/<name>.md`) | Global — available everywhere |

Project-level agents override global ones with the same name, so you can customize a global agent for a specific project.
The global location follows the upstream `PI_CODING_AGENT_DIR` env var — set it to relocate all pi-coding-agent state (agents, skills, settings) to a custom directory.

### Example: `.pi/agents/auditor.md`

```markdown
---
description: Security Code Reviewer
tools: read, grep, find, bash
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
wrap_up_turns: 2
max_duration_seconds: 900
---

You are a security auditor.
Review code for vulnerabilities including:

- Injection flaws (SQL, command, XSS)
- Authentication and authorization issues
- Sensitive data exposure
- Insecure configurations

Report findings with file paths, line numbers, severity, and remediation advice.
```

Then spawn it like any built-in type:

```text
subagent({ subagent_type: "auditor", prompt: "Review the auth module", description: "Security audit" })
```

### Frontmatter Fields

All fields are optional — sensible defaults for everything.

| Field               | Default        | Description                                                                                                                                                                                                                                                                                                             |
| ------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`       | filename       | Agent description shown in tool listings                                                                                                                                                                                                                                                                                |
| `display_name`      | —              | Display name for UI (e.g. widget, agent list)                                                                                                                                                                                                                                                                           |
| `tools`             | all 7          | The agent's complete tool allowlist — built-in or extension-registered names. `none` for no tools. See [Tool selection](#tool-selection)                                                                                                                                                                                |
| `model`             | inherit parent | Exact model pin (`provider/modelId`) or unqualified fuzzy name (`"haiku"`, `"sonnet"`). A qualified pin never fuzzy-matches another model or provider; an explicit model that cannot be resolved fails the spawn instead of inheriting the parent. |
| `thinking`          | inherit        | off, minimal, low, medium, high, xhigh                                                                                                                                                                                                                                                                                  |
| `max_turns`         | global limit   | Positive hard maximum for model turns. It can only tighten the global setting; `0` is invalid.                                                                                                                                                                                                                          |
| `wrap_up_turns`     | global setting | Non-negative turns reserved within the hard maximum for a final response. It is clamped to `0..max_turns - 1`.                                                                                                                                                                                                          |
| `max_duration_seconds` | global limit | Positive execution-time limit in seconds. It can only tighten the global setting.                                                                                                                                                                                                                                       |
| `prompt_mode`       | `append`       | `replace`: inherited identity followed by specialist instructions, without bridge or wrapper. `append`: adds the sub-agent bridge and wraps specialist instructions in `<agent_instructions>`. Child tools, skills, cwd, and project context are rebuilt in either mode. |
| `inherit_context`   | `false`        | Prepend parent user/assistant text and compaction summaries to the fresh task; tool results and non-text content are omitted. |
| `run_in_background` | `false`        | Run in background by default                                                                                                                                                                                                                                                                                            |
Enablement is not an agent-definition field. Use `/subagents:agents` to choose `当前项目` or `全局`, then enable, disable, or restore inheritance. Project overrides are stored in `<cwd>/.pi/subagents.json`; personal global overrides are stored in `~/.pi/agent/subagents.local.json`. The shared `~/.pi/agent/subagents.json` remains read-only for this feature. The persisted `agentEnabled` map uses project-over-global precedence.

Frontmatter is authoritative for `model`, `thinking`, `inherit_context`, and `run_in_background`: when set, those values are locked for that agent and tool parameters only fill omitted fields.
Only an omitted `model` inherits the parent model. An explicit model from the profile or the tool call is a pin: if it cannot be resolved (unknown name, model without auth, or a `provider/modelId` that is not an exact available match), the spawn fails with the available-model list and never substitutes the parent model.
Resource settings are deliberately different. `max_turns` and `max_duration_seconds` from a tool call may only lower the profile and global ceilings; they can never raise them. `wrap_up_turns` follows tool-call, then profile, then global precedence and is clamped below the effective hard turn limit.

### Tool selection

`tools` is the agent's **complete allowlist**, not a filter over the built-ins.
A child session gets exactly the tools it names — nothing else is enabled, whoever registered it.

Entries may name built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) or tools registered by any extension:

```yaml
---
description: Browser-driving researcher
tools: read, grep, find, agent_browser
---
```

Naming an extension's tool admits it when that extension registers it in the child. After binding extensions, every declared tool must be available; missing tools fail initialization with their names instead of disappearing silently. SDK built-ins (`codemode`, `tool_search`, and MCP) load only when the declared tools need them, respecting native disable settings and package exclusions. A tool list limits callable capabilities; it is not an operating-system sandbox.

Tool declarations accept unambiguous case-insensitive spelling for known built-ins and parent-registered names. An exact registered name wins. The finite aliases are `read_file` → `read`, `write_file` → `write`, `edit_file` → `edit`, `shell` → `bash`, and `glob` → `find`. Ambiguous casing is refused. Wildcard spelling is normalized only where its literal parts have one confirmed interpretation; unknown names still require a match after child extensions bind. These rules preserve the declared allowlist and respect disabled or excluded extensions.

Three names are always removed from a child, even when an agent lists them: `subagent`, `get_subagent_result`, and `steer_subagent`.
This is the recursion guard — without it, an agent could spawn agents of its own without bound.

Accepted forms, all equivalent:

```yaml
tools: read, grep, find      # comma-separated
tools: [read, grep, find]    # YAML flow sequence
tools:                       # YAML block sequence
  - read
  - grep
  - find
tools: none                  # no tools at all
```

Omitting `tools` entirely gives the agent all seven built-ins and no extension tools.

Two other settings interact with this list:

- [`excludedExtensionPackages`](#excluding-package-extensions-from-children) stops a package extension from loading in children; declaring its unavailable tools therefore fails initialization.
- When [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system) is installed, its `permission:` frontmatter narrows the set further, per turn.
  Use it to deny a tool; use `tools` to decide what the agent has in the first place.

## Persistent Settings

Runtime tuning values set via `/subagents:settings` (max concurrency, max turns, reserved wrap-up turns, maximum execution duration, maximum queue wait, abort grace, the two session-retention windows, and the abort-on-interrupt policy) persist across pi restarts.
A completed subagent's record is kept for the whole parent session (so `get_subagent_result` never misses); only its heavy in-memory session is released — after `consumedSessionRetentionMinutes` once the result has been collected, or after the `unconsumedSessionRetentionMinutes` safety cap if it never was.
Runtime settings and agent enablement use separate layers. Runtime settings are merged from two files:

- **Global shared:** `~/.pi/agent/subagents.json` — machine-wide runtime defaults and shared child-session policy. It is synchronized from `pi/agent/subagents.json`.
- **Project:** `<cwd>/.pi/subagents.json` — per-project runtime overrides. Written by `/subagents:settings`.

Agent enablement has an additional personal global layer:

- **Personal global:** `~/.pi/agent/subagents.local.json` — local `agentEnabled` overrides written by `/subagents:agents`.
- **Project:** `<cwd>/.pi/subagents.json` — project `agentEnabled` overrides, which take precedence over the personal global layer.

`/subagents:agents` never writes the shared global file. If an older shared file still contains `agentEnabled`, it is read as a compatibility layer below `subagents.local.json`.

**Precedence:** project overrides global on any field present in both.
Missing fields fall back to hardcoded defaults: max concurrency `4`, max turns `30`, reserved wrap-up turns `2`, maximum execution duration `1800` seconds, maximum queue wait `900` seconds, abort grace `5` seconds, consumed-session retention `10` minutes, unconsumed-session retention `720` minutes, and abort-all-on-interrupt `true`.

**Example — global defaults for a beefy machine:**

```bash
mkdir -p ~/.pi/agent
cat > ~/.pi/agent/subagents.json <<'EOF'
{
  "maxConcurrent": 16,
  "maxTurns": 20,
  "wrapUpTurns": 3,
  "maxDurationSeconds": 1200,
  "maxQueueWaitSeconds": 300,
  "abortGraceSeconds": 10,
  "unconsumedSessionRetentionMinutes": 1440,
  "abortAllOnInterrupt": false
}
EOF
```

Every project now starts with concurrency 16 and the stated finite resource ceilings, while ESC remains with the parent. Individual projects can still override settings through `/subagents:settings`.

All resource budgets are finite: `maxTurns`, `maxDurationSeconds`, `maxQueueWaitSeconds`, and `abortGraceSeconds` require positive integers; `wrapUpTurns` permits `0` and is clamped below `maxTurns`. A running invocation starts its duration clock at execution and includes workspace setup, session construction, model calls, and tools. Background queue wait is measured separately. On duration expiry or cancellation, the runtime signals cooperative abort; if the invocation remains unsettled once `abortGraceSeconds` passes, parent waiters and the concurrency slot are released. A same-process tool that ignores `AbortSignal` cannot be forcibly killed, and a cancelled record cannot resume until that prior invocation settles.

**Failure behavior:** missing file is silent; malformed JSON logs a `[pi-subagents] Ignoring malformed settings at …` warning to stderr; invalid/out-of-range field values are dropped per-field; write failures downgrade the `/subagents:settings` toast to a warning with `(session only; failed to persist)`.

### Excluding package extensions from children

Some package extensions are parent-scoped or expensive to initialize per session.
Because children run in the parent's process, such an extension initializing once per child multiplies its cost in a single heap — enough, in the case that motivated this feature, to exhaust the V8 heap with four concurrent children.

List the offending packages under `excludedExtensionPackages` to keep their extensions out of child sessions:

```json
{
  "excludedExtensionPackages": ["npm:@cortexkit/pi-magic-context"]
}
```

Entries must match Pi's configured package source string exactly, as it appears in your Pi `settings.json` `packages` array — there is no glob or prefix matching.

What this does and does not do:

- Only the matched packages' **extensions** are disabled, and only in children.
  Their skills, prompts, and themes stay available to children.
- The parent session is unaffected, as is the child's own settings — only the child's resource loading is filtered.
- The exclusion happens during package resolution, so the extension's module is never imported and its factory never runs in the child.
- Excluding a package keeps the **tools** that extension registers out of child sessions too: its factory never runs there, so an agent that names one of those tools in [`tools`](#tool-selection) gets nothing.
  If you need the tools but want the extension's resources released when the child is disposed, exclusion is the wrong lever — see [Child session lifecycle](../README.md#child-session-lifecycle).

This key is hand-edited in the shared global or project `subagents.json`; `/subagents:settings` does not expose it, but it is preserved when you change other runtime settings there. It is unrelated to personal `agentEnabled` overrides.
An absent or empty list reproduces the default behavior, in which children inherit every parent extension.

### Abort on interrupt

By default, pressing ESC to interrupt the parent agent also aborts every subagent.
Set `abortAllOnInterrupt` to `false` (or flip it from `/subagents:settings`) to keep background and queued subagents running when you interrupt the parent — useful when you spawn long background work and then want to steer the parent without losing it.

A foreground agent aborts on ESC regardless of this setting.
It holds the parent's own run signal for the duration of its blocking tool call, so the interrupt reaches it directly; the policy governs background and queued agents.

The policy is read at the moment ESC fires, so flipping it mid-session applies to the very next interrupt.
