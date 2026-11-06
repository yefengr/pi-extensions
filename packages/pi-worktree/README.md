# @yefengr/pi-worktree

Create and manage Git linked worktrees from Pi, move the current persistent session into them, and continue the original task in the new working directory. Switching uses Pi's native session replacement and footer; it does not change the old process's working directory or install a custom status bar.

## Requirements and installation

Requires **Pi >= 1.5.0**, Node.js >= 22.19.0, Git, and Bash on macOS or Linux. Pi supplies the runtime SDK; this package does not bundle another copy.

```bash
pi install npm:@yefengr/pi-worktree
```

Run `/reload` or restart Pi after installation. To remove the extension:

```bash
pi remove npm:@yefengr/pi-worktree
```

Uninstalling the extension does not delete worktrees, branches, or sessions.

## Commands

| Command | Action |
|---|---|
| `/worktree:create` | Collect a name, mode, and Git references, create the worktree, then migrate the persistent session |
| `/worktree:switch` | Select the current repository's main workspace or a Pi-managed worktree |
| `/worktree:migrate` | Migrate the session to an existing Pi-managed linked worktree |
| `/worktree:list` | List Pi-managed worktrees for the repository, newest first |
| `/worktree:remove` | Select one or more worktrees, confirm the scope, and remove them safely |

**Ctrl+Alt+W** opens the same workspace selector as `/worktree:switch`. Switching is available only when the agent is idle. Cancelling the selector does nothing, selecting the exact current directory is a no-op, and switching manually never requests an extra model turn. Pi's native footer reflects the replacement session's actual directory and branch.

Commands without arguments use native Pi dialogs in TUI mode. For scripted/RPC use, pass a single JSON object. `repoPath` defaults to the session's current directory; TUI mode asks for it if that directory is outside a Git repository.

```text
/worktree:create {"name":"task-one","mode":"new-branch","baseRef":"main","branch":"feat/task-one"}
/worktree:list
/worktree:switch {"worktreePath":"/absolute/path/to/worktree"}
/worktree:migrate {"worktreePath":"/absolute/path/to/worktree"}
/worktree:remove {"worktreePath":"/absolute/path/to/worktree","confirmed":true,"keepBranch":true}
```

The paths above are placeholders: use the actual path returned by creation or listing. Only `worktree:switch` can return to the main workspace; `worktree:migrate` accepts managed linked worktrees only.

### Creation modes

- `new-branch`: requires `baseRef` and a new `branch`.
- `existing-branch`: requires `branch`; do not supply `baseRef`.
- `detached`: requires `baseRef`; do not supply `branch`.

Names contain lowercase letters, digits, and single hyphens, with a maximum length of 40 characters. Worktrees live in `worktrees` beside the agent directory: the default is `~/.pi/worktrees`, **not** `~/.pi/agent/worktrees`. An absolute `PI_CODING_AGENT_DIR` changes the agent directory; its parent determines the worktree root. A leading literal `~` is expanded.

### Project setup hooks

If the source repository contains `.pi/worktree/setup.sh`, creation requires explicit approval. The creator invokes it with `before-create` and `after-create` stages. Approval is bound to the inspected script content; review the file and any symlink target before approving it. TUI creation shows its path, resolved path, and content identifier. JSON/tool calls must set `setupHookApproved: true` only after that review.

A failure after creation can leave the worktree for diagnosis; the error identifies its path and stage. Hook output is not echoed into the conversation, to avoid exposing sensitive output. A failed initialization does not migrate the session.

## Model tools and automatic continuation

| Tool | Parameters |
|---|---|
| `worktree_create` | `name`, `mode`, optional `repoPath`, `baseRef`, `branch`, `setupHookApproved` |
| `worktree_list` | Optional `repoPath` |
| `worktree_remove` | `worktreePath`, `confirmed`, optional `repoPath`, `keepBranch` |

A successful `worktree_create` in a persistent session schedules a handoff and terminates the current turn. Call it on its own, not alongside other tools in the same batch. Until the handoff completes, further tools in the old directory are blocked. After the first settled event, a real `/worktree:migrate` command switches sessions; only after verifying the replacement directory does an extension-authored message resume the original task once. It does not fabricate human input.

The tool result includes `migrationStatus` (`scheduled` or `unavailable`), a recovery `migrationCommand`, and an optional `migrationReason`, alongside creation details. If the request is cancelled, its source session changes, dispatch fails, or the dispatched command remains unconsumed at the next settled event, the pending gate is cleared instead of replayed. Follow the reported recovery command if needed. Temporary sessions cannot migrate or automatically continue; the created worktree remains usable.

Migration forks the existing persistent session into the target directory, preserving the source as its parent. It is not a second session-state system. The original session file is not rewritten to pretend it ran in another directory.

## Ownership and safe removal

Only Git-registered worktrees under the Pi worktree root with a valid Pi ownership marker are listed or removed. The marker remains **`pi-worktree-manager.json` in the worktree's Git administrative directory**, with `schemaVersion: 1` and an ISO creation time. This persistent format is intentionally unchanged so existing managed worktrees remain recognized; do not rename the marker.

Removal requires explicit confirmation. It refuses the main workspace, the current session's worktree (including when the session is in a subdirectory), locked worktrees, dirty worktrees, and unregistered or unowned paths. By default it also safely deletes the local branch: the branch must already be merged into the main workspace's `HEAD` and its configured upstream, if any. It never forces removal or branch deletion. Set `keepBranch: true` to remove only the worktree and preserve the branch. Detached worktrees have no associated branch to delete.

Batch removal confirms the selected paths and scope, rechecks targets after confirmation, stops on failure, and reports partial success rather than implying all targets were removed. Listing and removal show creation and latest commit times in the process's local timezone; structured timestamps stay ISO strings.

## Migration from the local extension

The old `worktree-create`, `worktree-switch`, `worktree-migrate`, `worktree-list`, and `worktree-remove` commands are replaced by the colon-separated commands above; no old aliases are registered. Model tools and Ctrl+Alt+W remain unchanged. New extension messages use `worktree:message`; Pi can still read old session messages without a conversion step. Disable the old local extension when enabling this package to avoid duplicate tools and shortcuts.

## Development

```bash
npm run typecheck -w @yefengr/pi-worktree
npm run lint -w @yefengr/pi-worktree
npm test -w @yefengr/pi-worktree
npm pack --dry-run -w @yefengr/pi-worktree
```

Tests include the migrated domain/session regressions, all creator shell cases, isolated tool/command/RPC smokes, a real Pi CLI round trip against a loopback-only synthetic model, and unpacked-tarball creation/removal. Fixtures are temporary and cleaned up; tests do not use real model credentials or user worktrees.

## License

[MIT](./LICENSE).
