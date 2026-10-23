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
4. Tool: `<capability>`, `<capability>_<action>`, or `<capability>_<object>`. Use the singular capability form when one call operates on a single element.
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

Releases use manual semantic versioning and npm Trusted Publishing (GitHub Actions OIDC). A push to `main` that changes a package's `package.json` version starts `.github/workflows/release.yml`. Dependency or source changes without a version bump do not release a package.

### One-time npm setup

Configure a Trusted Publisher on npmjs.com for **each** of the four published packages:

- Provider: GitHub Actions
- Owner: `yefengr`
- Repository: `pi-extensions`
- Workflow filename: `release.yml`
- Environment: leave empty (this workflow does not use a GitHub environment)

Do **not** enable the option that allows direct `npm publish`; `npm stage publish` remains allowed. No npm token is needed. Being listed as published above does not mean a package's Trusted Publisher has already been configured.

### Release a version

For example:

```bash
npm version patch --workspace @yefengr/pi-notify --no-git-tag-version
```

Commit the updated `package.json` and `package-lock.json`, then push to `main`. The workflow compares versions with the push's previous commit and checks the exact versions on the npm registry. Already-public versions are skipped; registry errors stop the workflow rather than being treated as unpublished versions.

For unpublished candidates, the workflow runs the reusable CI checks on Node.js 22.19.0, then each package's existing `prepublishOnly` checks and `npm pack` (including `prepack`) on Node.js 24.22.0. A separate OIDC job validates the uploaded tarball's identity and submits that tarball with `npm stage publish`; it does not install dependencies or run package lifecycle scripts.

**Successful staging is not a public release.** Open npmjs.com **Staged Packages**, review the pending package, and approve it with 2FA to make it public. A workflow that skips all versions stages nothing.

To retry a single package, run the **Release** workflow manually on `main` and select its package name. Other branches are rejected, and already-public versions are skipped. If that version is still awaiting approval, another staging attempt may fail: check the existing Staged Packages entry and approve it, or reject the old entry before retrying. The workflow never automatically approves or replaces pending entries.

If staging fails with `ENEEDAUTH`, the stage job first reports whether the OIDC endpoint was present. A missing endpoint means the job lost `id-token: write` or did not run from `main`; an `oidc` message in the verbose npm log means the registry rejected the exchange, so recheck the Trusted Publisher owner, repository, and workflow filename.

This flow does not update installed Pi copies, deploy a server, or create GitHub tags or releases. If a package was published under a name that was later reverted, mark the old name with `npm deprecate` pointing to the current package.

## License

MIT, except [`packages/pi-subagents`](./packages/pi-subagents), which retains the upstream `tintinweb` MIT copyright notice. See [LICENSE](./LICENSE).
