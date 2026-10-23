# @yefengr/pi-task-efficiency

A [Pi](https://pi.dev) task efficiency review extension maintained by [yefengr](https://github.com/yefengr). It reviews completed tasks in a separate session, reports verifiable time, token, cost, tool, and subagent metrics, and turns improvement suggestions into concrete files or rules.

## Installation

Requires Node >= 22.19 and Pi 1.x.

```bash
pi install npm:@yefengr/pi-task-efficiency
```

After installation, run `/reload` or restart Pi. The package also ships the package-bundled skill `analyze-task-efficiency`, which Pi discovers automatically after installation.

## Usage

```text
/task-efficiency
```

This command creates a separate review session and does not replace the current working session. The review flow always has four steps:

1. `task_efficiency_read_scope_page` reads the latest compact task scope page.
2. `task_efficiency_propose_scope` submits the full candidate scope and waits for the user to confirm or correct it.
3. If the boundary is still ambiguous, `task_efficiency_expand_scope` reads bounded detailed fragments.
4. After the user confirms, call `task_efficiency_analyze` and write the review using only the returned deterministic report.

The model does not compute metrics on its own, and model text is never treated as confirmation. No report can be produced before the scope is confirmed.

## Metric definitions

- Times are deterministic ranges for the parent session, the subagents, and the combined total; model estimates are not used.
- `usage` reports `parent`, `children`, and `combined` separately; `reasoning` is a subset of output and is not counted twice.
- Cost only aggregates the `usage.cost` already persisted in Pi session JSONL files; no price table is maintained.
- The overhead of the review session itself is isolated from the source task cost and is never mixed into the source task metrics.
- `coverage.complete` only means the core fields required by the report are complete; it does not cover optional fields.

## Read-only boundaries

The extension only reads session records that Pi has already persisted. It does not modify the project, configuration, memory, samples, or observations. Improvement suggestions produced by the review are suggestions only and are never written to files directly.

## Development

```bash
npm ci
npm run typecheck
npm test
```

TUI smoke:

```bash
npm run test:tui-smoke
```

## License

MIT, see [LICENSE](./LICENSE).
