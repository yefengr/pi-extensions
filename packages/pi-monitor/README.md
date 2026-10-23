# Monitor

A general-purpose background command monitoring extension for Pi. The model decides whether to start or resume a watch based on the user's request; no user confirmation is prompted. Registration returns immediately, and the check command runs in the background on an interval. When there are no new events the model is not invoked; when new events arrive, the extension only notifies or wakes the owning session to explain them. The extension understands nothing about your business and provides no API, database, or network search adapters.

## Loading and Trying It Out

Requires Node >=22.19 and Pi >=1.2.0. The executor supports macOS/Linux; Windows is not supported.

Install from npm:

```bash
pi install npm:@yefengr/pi-monitor
```

When developing inside this repository, you can load it temporarily from the repository root without modifying your personal package list:

```bash
pi --offline -ne -e ./packages/pi-monitor/index.ts
```

Send a regular message in a persistent session first, then register a watch. A brand-new blank Pi session does not create a session file when it only appends extension state, so watch rejects sessions that have not been persisted and rejects `--no-session`; it will not fabricate user messages just to force a session file onto disk. Start and resume support TUI or RPC mode and do not require the client to provide a confirmation interaction; print/JSON mode does not start checks.

To try a one-shot, notification-only watch in Pi:

```text
/monitor start {"name":"demo","purpose":"verify one-shot delivery","mode":"once","delivery":"notify","command":"node","args":["-e","console.log(JSON.stringify({state:'ok',events:[{id:'demo-1',summary:'check succeeded'}]}))"]}
```

It runs immediately after registration with no confirmation prompt. You can delegate registering an existing check command to the agent in natural language; the model verifies the command, arguments, directory, interval, and deadline against the user's request. When a new script is needed, the file-change plan is still confirmed first; the extension will not generate scripts on its own.

Long-term adoption in this repository follows the existing process; see the [deployment notes](../../docs/DEPLOYMENT.md). Loading from source does not mean it is installed on this machine; you must run setup and sync the source with the updated pix, then reload Pi.

## One-shot and Continuous Modes

| `mode` | After new events arrive |
|---|---|
| `once` | Saves the first batch of valid new events, stops checking, and waits to deliver the whole batch |
| `continuous` | Saves and delivers new events, and keeps checking |

The mode must be explicit. Every event returned by the first check is treated as a new event; to watch only changes after start, the check command must establish a baseline. In one-shot mode, if you only want to wait for the final result, the check command should return an empty event list during progress stages.

Check scheduling and delivery are independent: checks keep running while the agent is explaining, and after a one-shot check stops, results that have not been delivered yet are not discarded. `stop` only cancels the check and the child processes in its group; it does not stop remote business tasks.

## Tools and Commands

The model tool `monitor` provides `start`, `list`, `status`, `stop`, and `resume`. `start` and `resume` take effect immediately with no confirmation prompt. The tool is exposed only to the model and is not for nested calls by other tools.

```text
/monitor list
/monitor show <id>
/monitor show <id> <batchId> [eventId]
/monitor stop <id>
/monitor resume <id>
/monitor start <JSON>
```

In the TUI, `list` and `show` without a batch argument open the panel; non-TUI modes such as RPC and print fall back to multi-line text. `show` with a `batchId` always outputs text. By default `list` only lists tasks that are running, paused, or have results pending delivery, with a summary of the finished count at the end; only `list all` includes every historical task.

## Panel and Collapsing

The panel is a TUI-only presentation layer; it does not change the data visible to the model, nor does it modify the delivery protocol. Left and right padding follows Pi's `outputPad` setting; when the content width is under 68 columns, right-side notes are hidden and the shortcut hints are simplified.

| Key | Behavior |
|---|---|
| `↑` `↓` | Move the selection |
| `Enter` | Open details |
| `Esc` | In details, return to the list; in the list, close the panel |
| `s` | Stop checking; requires pressing twice to confirm |
| `r` | Resume a paused task or pending delivery results; tasks that are stopped, completed, or expired restart from the original definition (with a new id) |
| `PgUp` `PgDn` | Scroll details |
| `a` | Toggle the list scope: active only by default, toggled to include finished tasks |

`stop` only cancels the local check, but a stop with no pending delivery results cannot be resumed, which is why the panel requires a second confirmation. When `resume` fails, the reason is shown at the bottom of the panel and the panel stays open. Restarting differs from resuming: restarting creates a new task from the original definition, with the id, event deduplication, cursor, and log all starting over, while the original task is kept as history. While the panel is open, automatic delivery is paused and resumes from the existing queue once it closes, so that model turns do not interrupt the modal UI; check scheduling is unaffected, and the panel redraws status once per second. Reload, tree navigation, or switching sessions closes the panel.

Tool calls are collapsed to two lines by default: `monitor <action>` and one line of result statistics. Press `ctrl+o` to expand arguments and the full result; clicking the result area toggles the same. Collapsing only affects TUI display; the tool `text` still enters the model context in full. Delivery cards are not collapsed.

`start` parameters:

| Field | Rule |
|---|---|
| `name`, `purpose` | Required; the task name and the original purpose of the watch |
| `mode` | Required; `once` or `continuous` |
| `command`, `args` | The executable and an array of arguments; shell strings are not concatenated |
| `cwd` | Defaults to the current directory; relative paths are resolved to absolute paths |
| `explanation` | Optional; what you want explained, not authorization for follow-up actions |
| `delivery` | `explain` (default) or `notify` |
| `intervalSeconds` | Defaults to 30 seconds; range is 1 second to 24 hours |
| `timeoutSeconds` | Defaults to 10 seconds; range is 0.1–300 seconds |
| `maxDurationSeconds` | Optional; range is 1 second to 365 days; omitted means no time limit |
| `logLevel` | Optional; `off`, `info` (default), or `debug`, see "Logs" |
| `autoResume` | Optional boolean; when `true`, the task continues automatically after restarting Pi (`startup`) or switching back to the session (`resume`). By default it pauses and waits for `resume` |

The deadline is computed from registration time; pausing, reload, and resuming never extend it. Expired tasks no longer run checks.

`status` with only the `id` parameter shows the latest state; adding `batchId` shows that batch's event directory, and adding `eventId` reads a single full event. Results come from the raw state snapshot of the current branch, so they remain queryable even after a batch has been delivered. The `show` command provides the corresponding entry point. State output includes `logLevel` and `logPath`.

## Check Protocol

stdin provides one line of JSON; commands that do not need incremental state may skip reading it:

```json
{"monitorId":"watch ID","cursor":null}
```

stdout must be exactly one JSON object; do not mix in logs. No new events:

```json
{"state":"ok","events":[]}
```

With new events:

```json
{
  "state":"ok",
  "events":[
    {"id":"job-123:completed","summary":"task finished","data":{"result":"the actual result"}}
  ],
  "cursor":"incremental checkpoint maintained by the check command"
}
```

The check itself failed:

```json
{"state":"error","summary":"query API is temporarily unavailable"}
```

A failing business task can be a normal event; a check error, non-zero exit, timeout, invalid JSON, and output over the limit are check failures and do not count as one-shot task completion. Diagnostic logs go to stderr.

The protocol strictly rejects unknown fields. stdout and stderr total at most 64 KiB; at most 32 events per check, event IDs at most 256 characters and free of control characters, summaries at most 500 characters, JSON for a single `data` at most 8192 UTF-8 bytes, and cursors at most 4096 characters.

### Deduplication and Incremental Reads

An event ID identifies one event, not a business object. The same event returned again with the same ID is not delivered twice; new progress on the same object uses a new ID, and deduplication is never based on summary text.

`cursor` is an optional opaque string. The extension passes the last accepted cursor to the next check round and advances it only after the events, the pending delivery queue, and the deduplication state have all been saved successfully. The check command must ensure that, after the cursor advances, old events are not replayed across an already-advanced checkpoint.

Each task keeps at most the 1000 most recent event IDs. Old IDs may be evicted only when the cursor advances; with no cursor, or with an unchanged cursor and insufficient capacity, the task pauses and does not accept this batch, rather than silently forgetting events and notifying again. Each task holds at most 16 batches of pending results; when full it likewise pauses and keeps the existing results. After the backlog is handled, the model decides whether to call `resume`; the batch that was not accepted is offered again by the check command.

## Delivery and Permissions

- `explain`: one-shot results are handed off immediately when idle; continuous mode merges them in a 5-second window. While the agent is busy or user messages are queued, results stay in the local pending delivery queue and the owning context is re-verified once idle. It uses Pi native custom messages and `followUp` and does not interrupt work.
- `notify`: only writes an extension entry, shows the result card, and sends a UI notification; it does not invoke the model and is not automatically added to later model context. Data explicitly queried via `status` is of course handed to the caller.

Automatic delivery shows a Markdown preview: task title, batch information, event summaries, and data code blocks; a single message is limited to 32000 characters, batches are selected as a whole, and batches that are not shown keep waiting instead of being confirmed as dropped by truncation. The preview limits the length of `summary`, event IDs, and data and flattens whitespace so external text cannot forge structure; when full evidence is needed, the agent can query a specified batch and event read-only.

The automatic explanation turn blocks other tools through `tool_call`, allowing only `watch list/status` and `stop` for the watch tasks involved in this receipt; the `stop` `id` must exactly match the `taskId` in the receipt. `stop` only cancels the local check and never touches remote state, so after a terminal event is delivered the turn can wrap up within the same round instead of idling until the deadline. External output is not a new instruction and cannot authorize fixes, restarts, file changes, or other follow-up actions; a new user request enters a new normal execution turn. Model explanation may fail or require multiple model requests; the extension does not guarantee a fixed number of calls.

Commands inherit the current user's permissions and existing environment; this is not a sandbox. Common plaintext credential arguments are rejected, but that is not a complete secret scan; the model must still check a command's purpose and permissions against the user's request and avoid putting passwords or tokens in arguments, cursors, results, or the session. Use existing environment variables, credential files, or the system credential manager. Check scripts and their dependencies must be trusted and should not spawn background daemons; a malicious process deliberately escaping its process group is outside the executor's isolation guarantees.

## Logs

By default a task writes its run records to `.pi/logs/monitor/<task name>-<first 8 chars of id>.jsonl` in the project that the check command's `cwd` belongs to. "Owning project" means the nearest directory containing `.git` found by walking up from `cwd` (the `.git` placeholder file of a worktree is supported); if none is found, `cwd` itself is used. When the directory is first created, `.pi/logs/.gitignore` is written with the content `*`; the project root `.gitignore` is not modified.

Each line is one JSON event containing `ts`, `taskId`, `name`, `sessionId`, and `action`; `action` is one of `start`, `check`, `pause`, `resume`, `stop`, `complete`, `expire`, `deliver`, `deliver-error`, or `receipt-error`.

| Level | What is recorded |
|---|---|
| `off` | No logs are written |
| `info` (default) | Scheduling and result metadata, `check` duration and event count, new event `id` and full `summary`, failure and pause reasons, delivered batches |
| `debug` | Everything in `info`, plus the command and arguments, `cursor` length, and the first 512 characters of event `data` |

`debug` must be set explicitly at `start` and should only be used briefly while troubleshooting; it writes commands, arguments, and event data previews into an in-project log that may contain sensitive business information, so enable it only on trusted projects. Logs do not record environment variables, full stdout, or `purpose`; the check command's own diagnostics should still go to stderr.

When a single file exceeds 1 MiB it is rotated to `.1`, keeping at most `.1`–`.3`; a task with a 1-second interval keeps roughly the last few hours. A write failure only disables that task's log and raises a one-time UI warning; it does not affect check scheduling, state commits, receipt verification, or deduplication. Logs are not the source of truth for state or receipts. Nothing is written after `stop` or `expire`, and old files are not cleaned up automatically:

```bash
find .pi/logs/monitor -name '*.jsonl*' -mtime +30 -delete
```

## Scheduling and Recovery

Checks for the same task never overlap, and the shared concurrency limit is 2. The current session holds at most 16 running, paused, or pending-delivery tasks, plus a cache of the 32 most recent terminal tasks with no backlog. `list` returns only these tasks; older tasks can still be queried by ID via `show/status` from the current branch history, without deleting session evidence. The next round is computed after the current round ends, and missed rounds are not caught up. Check errors use exponential backoff capped at 5 minutes, but a longer user-configured interval is not shortened; after 5 consecutive failures the task pauses and warns.

Tasks and key state are saved with Pi's `appendEntry()` and appended only on substantive changes; empty polls and duplicate results only update the in-memory last check time. Result acceptance and delivery acknowledgment are separate. Pi's `message_end` callback runs before the write to disk, so the extension verifies the full receipt in the session file after the callback ends before clearing the corresponding batch; on recovery it also checks persisted receipts to avoid duplicate delivery after an ordinary reload. When an async send is unacknowledged, results are kept and a warning is raised; retry with `/monitor resume <id>`. If the receipt has been written but saving the ACK state still fails, re-delivery stays blocked and the session store must be repaired first. Strict exactly-once semantics across crashes are not promised.

| Lifecycle | Behavior |
|---|---|
| `/reload` | Cleans up old resources and resumes the tasks that were running before |
| Re-entering the session | Paused by default; the model decides whether to call `resume`. Tasks with `autoResume: true` continue automatically on `startup` and `resume` |
| Tree navigation | Pauses the old branch first, then rebuilds from the target branch; cancelling navigation also leaves it paused |
| fork/clone | Does not inherit execution permission from another session; it does not continue even with `autoResume: true` |
| Pi exit or session switch | Cancels local timers and checks; late results are not written into another session |

For a task whose check has stopped but which still has pending results, `resume` can resume delivery only, without restarting the check. Tasks that are completed, stopped, or expired with no pending results cannot be resumed; create a new task instead.

The status bar only shows a summary of the current session, for example `monitor paused 1 · pending 2 · running 3 · retrying 1`. The running count includes retries; pending delivery is counted by task. Paused and pending-delivery counts are shown with priority, zero items are hidden, and the whole item is hidden when there are no active or pending tasks.

Watching does not continue after Pi shuts down, and no daemon is provided. Do not run the same session from multiple Pi processes at the same time. Raw session JSONL files are not cleaned up automatically and still grow with real events; limiting per-check output and in-memory state does not mean disk history is permanently bounded.

## Development Verification

Run from the repository root:

```bash
npm --prefix packages/pi-monitor test
npm --prefix packages/pi-monitor run typecheck
cd runtimes/go && go test ./...
```

Type checking requires the dev dependencies in the manifest and the Pi peer. Integration tests reuse the installed Pi; `PI_MONITOR_PI_ROOT` can point at that package root. They never install anything or rewrite personal configuration for tests. The RPC notification smoke uses an isolated HOME, a seeded session, and notification-only mode to check confirmation-free start/resume, both modes, reload, and session switching without invoking the model. The explanation-turn smoke uses a local HTTP model-response fixture to verify that native messages are written to disk and write tools are blocked; it does not access external models and incurs no real model costs.
