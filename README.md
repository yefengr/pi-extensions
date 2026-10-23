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

Package names, command names, and capability names follow the same rule. Consistency means the same word, not the same word shape.

1. A package is `@yefengr/pi-<capability>`. The capability name is the extension's core ability; do not abbreviate it or drop qualifiers.
2. The command name is the capability name. Multiple commands use `<capability>:<action>`.
3. A tool name is the capability name. A single invocation may be singular while the package keeps the plural capability name.
4. Events and service keys use `<capability>:*`. Cross-package service keys use `@yefengr/pi-<capability>:service`.
5. A skill name is `<action>-<capability>`, for example `analyze-task-efficiency`.
6. Do not rename for brevity or word-shape symmetry. Semantics win over appearance.

| Extension | Package | Command | Tool | Events | Skill |
|---|---|---|---|---|---|
| Notifications | `pi-notify` | `notify:*` | `notify_user` | `pi-notify:*` | — |
| Monitoring | `pi-monitor` | `monitor` | `monitor` | `monitor` | — |
| Task review | `pi-task-efficiency` | `task-efficiency` | `task_efficiency_*` | `task-efficiency:*` | `analyze-task-efficiency` |
| Subagents | `pi-subagents` | `subagents:*` | `subagent` | `subagents:*` | — |

Two visible asymmetries are intentional and allowed by rules 3 and 5: `pi-subagents` is a capability set while the `subagent` tool describes one invocation, and `analyze-task-efficiency` combines an action with the capability name.

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
