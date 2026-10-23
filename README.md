# pi-extensions

[Pi](https://pi.dev) extensions maintained by [yefengr](https://github.com/yefengr). Each package is an independent npm package and can be installed on its own.

## Packages

| Package | Description | Status |
|---|---|---|
| [`@yefengr/pi-notify`](./packages/pi-notify) | Desktop notifications through native terminal OSC protocols, with no system notification helper | Published |
| [`@yefengr/pi-monitor`](./packages/pi-monitor) | Background command monitoring with one-shot or continuous checks, notification-only or explained delivery | Published |
| [`@yefengr/pi-task-efficiency`](./packages/pi-task-efficiency) | Task efficiency review with scope confirmation, deterministic metrics, and actionable suggestions | Published |
| [`@yefengr/pi-subagents`](./packages/pi-subagents) | In-process subagent runtime with background execution, steering, resume, and lifecycle events | Published |

## Install

Requires Pi 1.x and Node.js >= 22.19.0.

```bash
pi install npm:@yefengr/pi-monitor
pi install npm:@yefengr/pi-notify
```

Run `/reload` or restart Pi after installation. Remove a package with:

```bash
pi remove npm:@yefengr/pi-monitor
```

## Naming

Naming is layered: the capability root stays fixed, while each layer uses the word shape that matches its role.

1. Capability root: one stable word or phrase per extension, such as `notify`, `monitor`, `task-efficiency`, or `subagents`. Never abbreviate it or replace it with a synonym (`efficiency` for `task-efficiency`, `agent` for `subagents`).
2. Package: `@yefengr/pi-<capability>`. Plural is allowed when the capability is a set.
3. Command: `<capability>`. Multiple commands use `<capability>:<action>`.
4. Tool: `<capability>` or `<capability>_<action>`. A single invocation may use the singular form.
5. Event, record, and log namespace: `<capability>:*`; log paths use the capability as the directory name. Cross-package service keys use `@yefengr/pi-<capability>:service`, because `Symbol.for` requires global uniqueness.
6. Skill: `<action>-<capability>`.

Every visible difference follows from these rules; there are no exceptions.

| Capability | Package | Command | Tool | Event / record | Skill |
|---|---|---|---|---|---|
| notify | `pi-notify` | `notify:*` | `notify_user` | `notify:*` | — |
| monitor | `pi-monitor` | `monitor` | `monitor` | `.pi/logs/monitor` | — |
| task-efficiency | `pi-task-efficiency` | `task-efficiency` | `task_efficiency_*` | `task-efficiency:*` | `analyze-task-efficiency` |
| subagents | `pi-subagents` | `subagents:*` | `subagent` | `subagents:*` | — |

## Development

```bash
npm install
npm run typecheck
npm test
```

Verify a single package:

```bash
npm test -w @yefengr/pi-monitor
npm run typecheck -w @yefengr/pi-notify
```

Inspect the published tarball before releasing:

```bash
npm pack --dry-run -w @yefengr/pi-notify
```

## Publishing

Releases use manual semantic versioning. The first version of each package was published from a 2FA-authenticated terminal; later versions can use npm Trusted Publishing (GitHub Actions OIDC) through `.github/workflows/release.yml` once the publisher is configured on npmjs.com.

If a package was published under a name that was later reverted, mark the old name with `npm deprecate` pointing to the current package.

## License

MIT, except [`packages/pi-subagents`](./packages/pi-subagents), which retains the upstream `tintinweb` MIT copyright notice. See [LICENSE](./LICENSE).
