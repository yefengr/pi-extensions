# @yefengr/pi-worktree

Create and manage Git linked worktrees from Pi, resume an existing workspace's saved session, or move the current persistent session into a new worktree and continue the original task. Switching and migration use Pi's native session replacement and footer; they do not change the old process's working directory or install a custom status bar.

## Requirements and installation

Targets **Windows 10/11**, macOS, and Linux with **Pi >= 1.5.0**, Node.js >= 22.19.0, and Git available on PATH. Creation, listing, switching, migration, and safe removal use native Node.js APIs and Git argv calls, without a Shell creator or additional runtime dependencies. Bash is needed only for optional project setup hooks on macOS/Linux. Pi supplies the runtime SDK; this package does not bundle another copy.

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
| `/worktree:switch` | Resume a saved session in the current repository's main workspace or a Pi-managed worktree |
| `/worktree:migrate` | Migrate the session to an existing Pi-managed linked worktree |
| `/worktree:list` | List Pi-managed worktrees for the repository, newest first |
| `/worktree:remove` | Select one or more worktrees, confirm the scope, and remove them safely |

Switching is available only when the agent is idle. It restores the selected workspace's saved session, including its original ID and conversation, without copying the current conversation or requesting an extra model turn. Selecting the exact current directory is a no-op unless a different session is explicitly selected. Pi's native footer reflects the restored session's actual directory and branch. The extension no longer registers **Ctrl+Alt+W**; use `/worktree:switch` to open the workspace selector.

Commands without arguments use native Pi dialogs in TUI mode. For scripted/RPC use, pass a single JSON object. `repoPath` defaults to the session's current directory; TUI mode asks for it if that directory is outside a Git repository.

```text
/worktree:create {"name":"task-one","mode":"new-branch","baseRef":"main","branch":"feat/task-one"}
/worktree:list
/worktree:switch {"worktreePath":"/absolute/path/to/worktree"}
/worktree:migrate {"worktreePath":"/absolute/path/to/worktree"}
/worktree:remove {"worktreePath":"/absolute/path/to/worktree","confirmed":true,"keepBranch":true}
```

The paths above are placeholders: use the actual path returned by creation or listing. Only `worktree:switch` can return to the main workspace; `worktree:migrate` accepts managed linked worktrees only.

### Resume workspace sessions

After selecting a workspace, `/worktree:switch` opens its only valid saved session directly. If several sessions exist, TUI mode shows a second selector ordered by recent conversation activity, with the session name or first-message summary, recent activity time, and a short session ID. Cancelling either selector leaves the current session open. A workspace with no recoverable saved session produces a notice; switching does not create or migrate a session as a fallback.

Scripted/RPC calls can select an exact saved session with `sessionId`:

```text
/worktree:switch {"worktreePath":"/absolute/path/to/worktree","sessionId":"full-session-id"}
```

Outside TUI mode, multiple candidates require `sessionId`. The selected session must belong to the target workspace. A missing or invalid file fails recovery rather than opening a blank session. Discovery includes the target's default session directory, the active session storage directory, and the directory of the current session's native parent when present, with canonical-path matching. The parent reference lets a migrated session find its original custom directory even after Pi changes the active storage directory. Arbitrary historical custom directories outside these sources are not searched. An empty or temporary current session can resume an existing saved target session.

### Operation feedback

Creation, switching, migration, and removal show temporary progress through Pi's native status API, without replacing the footer or opening a loading dialog. Status updates include the current stage and actual elapsed seconds; batch removal also shows the target name and `i/n`. Loading and preflight checks finish before selectors or confirmation dialogs open. Status is cleared on completion, failure, cancellation, or session replacement. No percentage or estimated completion time is invented.

TUI displays these statuses in the footer; RPC receives native status updates when UI support is available. Print/JSON modes do not attach terminal UI components. The `worktree_create` and `worktree_remove` tools also send progress through tool updates, including without UI support; final structured results are unchanged. Elapsed updates are transient feedback, not one persistent conversation message per second.

### Creation modes

- `new-branch`: requires `baseRef` and a new `branch`.
- `existing-branch`: requires `branch`; do not supply `baseRef`.
- `detached`: requires `baseRef`; do not supply `branch`.

Names contain lowercase letters, digits, and single hyphens, with a maximum length of 40 characters. On Windows, device names such as `con`, `nul`, `com1`–`com9`, and `lpt1`–`lpt9` are rejected. Worktrees live in `worktrees` beside the agent directory: the default is `~/.pi/worktrees`, **not** `~/.pi/agent/worktrees`. An absolute `PI_CODING_AGENT_DIR` changes the agent directory; its parent determines the worktree root. A leading literal `~` is expanded.

### Project setup hooks

**Windows does not support `.pi/worktree/setup.sh`.** If this path exists in the source repository, creation reports an explicit error before creating the worktree root, branch, or worktree, and before running any hook. Approval does not override this restriction; the hook is never silently skipped and Bash is not located or executed on Windows.

On macOS/Linux, if the source repository contains `.pi/worktree/setup.sh`, creation requires explicit approval. The creator invokes it with `before-create` and `after-create` stages. Approval is bound to the inspected script content; review the file and any symlink target before approving it. TUI creation shows its path, resolved path, and content identifier. JSON/tool calls must set `setupHookApproved: true` only after that review.

Each hook runs in the source directory (`before-create`) or target directory (`after-create`), with the resolved absolute `PI_CODING_AGENT_DIR`, the stage argument, and `PI_WORKTREE_PHASE`, `PI_WORKTREE_SOURCE_ROOT`, `PI_WORKTREE_TARGET`, `PI_WORKTREE_BASE`, `PI_WORKTREE_BRANCH`, `PI_WORKTREE_NAME`, and `PI_WORKTREE_MODE` environment variables. The resolved file and content are checked again before each stage. Hook output is discarded; each stage has a two-minute timeout, and cancellation terminates its POSIX process group.

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

### Known migration limitation: a new session has not been saved yet

Deferred: `/worktree:migrate` and creation followed by migration can fail with `Cannot fork: source session file is empty or invalid` when the current persistent session has only setup records and no user or assistant message. Pi allocates a session path before creating the file, but migration currently treats that path as a readable source. The same error can therefore mean that the source file does not exist. The target worktree remains available.

For migration, send an ordinary message in the source session, wait for the response to finish, and retry `/worktree:migrate` against the existing worktree. Do not recreate the worktree. This source-persistence case is recorded for a later migration fix; workspace session recovery through `/worktree:switch` does not require a saved source file.

## Ownership and safe removal

Only Git-registered worktrees under the Pi worktree root with a valid Pi ownership marker are listed or removed. The marker remains **`pi-worktree-manager.json` in the worktree's Git administrative directory**, with `schemaVersion: 1` and an ISO creation time. This persistent format is intentionally unchanged so existing managed worktrees remain recognized; do not rename the marker.

Removal requires explicit confirmation. It refuses the main workspace, the current session's worktree (including when the session is in a subdirectory), locked worktrees, dirty worktrees, and unregistered or unowned paths. By default it also safely deletes the local branch: the branch must already be merged into the main workspace's `HEAD` and its configured upstream, if any. It never forces removal or branch deletion. Set `keepBranch: true` to remove only the worktree and preserve the branch. Detached worktrees have no associated branch to delete.

Batch removal confirms the selected paths and scope, rechecks targets after confirmation, stops on failure, and reports partial success rather than implying all targets were removed. Listing and removal show creation and latest commit times in the process's local timezone; structured timestamps stay ISO strings.

## Migration from the local extension

The old `worktree-create`, `worktree-switch`, `worktree-migrate`, `worktree-list`, and `worktree-remove` commands are replaced by the colon-separated commands above; no old aliases are registered. Model tools remain available, and workspace selection uses `/worktree:switch` without a registered shortcut. New extension messages use `worktree:message`; Pi can still read old session messages without a conversion step. Disable the old local extension when enabling this package to avoid duplicate tools.

## Development

```bash
npm run typecheck -w @yefengr/pi-worktree
npm run lint -w @yefengr/pi-worktree
npm test -w @yefengr/pi-worktree
npm pack --dry-run -w @yefengr/pi-worktree
```

Tests include the migrated domain/session regressions, native Node.js coverage of the former creator Shell cases, isolated tool/command/RPC smokes, a real Pi CLI round trip using a relative built-in `read` against a loopback-only synthetic model, and unpacked-tarball creation/removal. Windows hook tests assert early rejection rather than requiring Bash. Packaging tests require `tar` on PATH and invoke npm through Node.js plus `npm-cli.js`, not `npm.cmd`. Windows drive/UNC and junction behavior must be verified on real Windows; a passing Linux run alone is not Windows runtime evidence. Fixtures are temporary and cleaned up; tests do not use real model credentials or user worktrees.

## License

[MIT](./LICENSE).
