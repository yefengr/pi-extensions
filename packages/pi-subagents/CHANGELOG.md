# Changelog

All notable changes to `@yefengr/pi-subagents` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 0.4.2

- Remove imported upstream changelog entries so Pi only detects this package's releases and stops showing upstream updates on every startup.
- Keep upstream provenance in the repository instead of the npm package, with published documentation linking to the repository copy.
- Add startup changelog regression coverage for repeated launches and upgrades from recorded package versions.

## 0.4.1

- Remove inherited Task Status and browser guidance when the corresponding tools are unavailable in the child, while preserving user-authored prompt sections and guidelines.
- Synchronize child tool guidance after final tool policy is applied and across tool changes or reloads, including browser tools exposed through codemode or deferred calls.
- Verify Task Status package exclusion and prompt inheritance with the real SDK, including Windows paths containing Chinese characters, spaces, and `#`.

## 0.4.0

- Allow explicit background resume for live and safely reopened sessions through the existing queue, rejecting duplicate active resumes and isolating stale queue callbacks by invocation.
- Share foreground progress updates across fresh runs and resumes, and add a query-only `timeout_seconds` limit to result waits (default 60 seconds, range 1–3600).
- Report observed activity, current invocation turns, and last progress age consistently in queries, tool output, widgets, and optional service snapshots, without adding persisted lifecycle fields or inferring stalls.
- Normalize finite tool aliases and unambiguous casing before SDK admission; preserve exact registered names, reject ambiguity, and retain post-bind missing-tool checks.

- Rebuild child environment instructions from verified structured prompt options, inherit thinking and project trust, and load SDK built-in extensions only for declared tools; require Pi SDK `>=1.5.1`.
- Classify final model errors and empty responses within the current invocation, check cancellation before initialization, and retain ownership while underlying work or cleanup remains unsettled.
- Read saved v2/v3 results and transcripts from the current parent-session branch after in-memory records disappear, reporting incomplete history without starting a model request.
- Add same-parent cold resume for v3 histories with a verified private close checkpoint and no ownership marker, preserving agent/session IDs, invocation sequence, and lifetime metrics. Old or abnormal histories remain query-only; public lifecycle v3 and service contracts stay unchanged.

- Make persisted-result and session-lease tests portable across Windows and POSIX, and include Subagents in the Windows CI matrix.

## 0.3.0

- Remove the built-in `Explore` and `Plan` agent types; `general-purpose` is now the only embedded default and remains the fallback for unknown types.
- Add `is_default` and `tool_guideline` frontmatter fields so custom agents can join the default agent list and contribute a hint line to the `subagent` tool description.
- Correct the `model` pin documentation: an unavailable pinned model now inherits the parent model instead of failing the spawn.

## 0.2.0

- Ship the package-bundled skill `orchestrate-subagents`, covering capability checks, delegation readiness gates, ownership and evidence handoff, review triggers, and lifecycle closeout.
- Declare `pi.skills` and include `skills/` in the published files.

## 0.1.1

- 恢复为 @yefengr/pi-subagents 与 subagents: 前缀。

- Rename `@yefengr/pi-subagents` to `@yefengr/pi-subagent`, command and event prefixes from `subagents:` to `subagent:`, and the service key to `@yefengr/pi-subagent:service`; keep `subagents.json` unchanged and provide no compatibility aliases.

- Rename the package to `@yefengr/pi-subagents` and the cross-extension service identity to `@yefengr/pi-subagents:service` without a compatibility alias.
- Publish to npm; installation is no longer tied to a local package checkout.
- Remove the managed-profile test that asserted the agent-tools host repository configuration.

## 0.1.0

- Import the verified `@gotgenes/pi-subagents@19.3.4` source and tests as an independently maintained local package.
- Replace monorepo-only pnpm/catalog/config inheritance with package-local npm tooling.
- Target Pi `0.85.1`, including `typebox` schemas and child `ModelRuntime` provider inheritance.
- Rename the package and cross-extension service identity to `agent-tools-subagents` without a compatibility alias.
- Replace legacy lifecycle payloads with strict lifecycle record v2 across public events and `subagents:record` persistence.
- Retain stable child `sessionId` and optional diagnostic `outputFile` after session release, including bind-failure paths.
- Track fresh and resume invocation identity separately, requiring the current parent `toolCallId` for tool-driven runs.
- Add zero-based per-invocation usage and tool-use windows while preserving lifetime totals across resume.
- Persist foreground and background terminal invocations through the same lifecycle path; completion nudges remain background-only.
- Include the stable Agent ID in fresh foreground success and failure text so a parent model can resume the returned agent directly.
