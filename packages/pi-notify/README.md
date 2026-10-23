# Pi Local Terminal Notify Extension

This is the Pi local terminal notification extension maintained by [yefengr](https://github.com/yefengr). It sends desktop notifications only through notification protocols supported by the current terminal, and does not call `terminal-notifier`, `notify-send`, or any other system notification helper.

## Supported Scope

Only Pi running directly on the host is considered; containers, SSH, tmux, screen, and zellij are not handled.

| Terminal | Protocol | Title and body |
|------|------|------------|
| Ghostty | OSC 777 | Separate |
| WezTerm | OSC 777 | Separate |
| kitty | OSC 99 | Separate |
| iTerm2 | OSC 9 | Merged into one text |

Apple Terminal.app, the default Linux terminal, and other terminals that are not on the allowlist do not send notifications. The extension does not fall back to a fixed system icon, and it does not guess whether an unknown terminal is compatible with a given protocol.

A successful terminal protocol write only means the sequence was submitted to the terminal; it does not mean the system has displayed the notification. The terminal's own desktop notification settings still apply.

## Notification Levels

The extension uses three semantic levels and sets a default display duration for each level:

| Level | Typical case | Default duration |
|------|----------|----------|
| `info` | Normal completion, session end, test notifications | 5 seconds |
| `warning` | Output reaching the length limit, states that need attention but are not fatal | 8 seconds |
| `error` | Agent, Provider, or tool errors | 12 seconds |

kitty's OSC 99 encodes the level as `u=0/1/2` and requests auto-close through `w=5000/8000/12000`; `timeoutMs` in the send result is returned only when that protocol actually carries it. The OSC 777/9 used by Ghostty, WezTerm, and iTerm2 does not support unified level and duration parameters, so it still follows the notification policy of the terminal and the operating system. The extension does not send persistent notifications.

## Commands

| Command | Description |
|------|------|
| `/notify:settings` | Configure the global switch, Pi lifecycle events, and recap |
| `/notify:recap-model` | Choose the recap model from the models currently available to Pi |
| `/notify:test` | Send a test notification and display `sent`, `unsupported`, `disabled`, or `failed` |

All configuration is maintained through commands; manual JSON editing is not required. The actual configuration is stored in:

```text
~/.pi/agent/config/notify.json
```

## Lifecycle Events

The extension listens only to Pi's native lifecycle and does not depend on events emitted by other extensions.

| Event | Default state | Description |
|------|----------|------|
| `agent_end` | Off | A single Agent run ended; it may fire repeatedly on retries |
| `agent_settled` | On | The Agent finished after retries, compaction, and queued continuations all ended |
| `session_shutdown` | Off | The session ended |

`/notify:settings` can change the global switch and the switches for the events above. After the global switch is turned off, lifecycle events are skipped silently and return the `disabled` state.

`agent_settled` uses different levels depending on the final run result: normal completion sends `info`, output reaching the length limit sends `warning`, and other errors send `error`. An explicit manual abort does not send a desktop notification.

## Agent Tool

Tool name: `notify_user`

```ts
notify_user({
  title: "Build failed",
  message: "TypeScript compilation failed. Check the build log.",
  level: "error"
})
```

The tool accepts `message`, an optional `title`, and an optional `level`; `level` may be `info`, `warning`, or `error`, and defaults to `info`. The tool synchronously returns the following states:

- `sent`: the notification sequence has been written to the current terminal;
- `unsupported`: the current terminal is not on the supported allowlist, or standard output is not a TTY;
- `disabled`: global notifications are turned off;
- `failed`: writing the terminal protocol sequence failed.

Only `sent` triggers the `notify:sent` event. The returned details and the sent event contain the actual level; only kitty OSC 99 contains the applied `timeoutMs`.

## Recap

Recap is off by default and takes effect only for `agent_end` and `agent_settled` notifications of normal completions. Once enabled, the extension sends the last Assistant reply to the model chosen through `/notify:recap-model` and generates a one-sentence notification summary. Abnormal termination uses the actual error directly and does not call the recap model; an explicit manual abort sends no notification and does not call the recap model.

Before calling the model, the extension first checks whether the current terminal supports notification protocols. When it does not, no model is called and no extra cost is incurred. If the model request fails, no API key is available, or the returned content is empty, the extension falls back to a deterministic lifecycle message.

Enabling recap causes extra model calls and may send content from Assistant replies to the selected model service. Enable it explicitly through `/notify:settings`.

## License

MIT. See [LICENSE](./LICENSE) for details.
