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
6. Skill: `<action>-<capability>`. The `pi-` package prefix never appears in a skill name.

Every visible difference follows from these rules; there are no exceptions.

| Capability | Package | Command | Tool | Event / record | Skill |
|---|---|---|---|---|---|
| notify | `pi-notify` | `notify:*` | `notify_user` | `notify:*` | — |
| monitor | `pi-monitor` | `monitor` | `monitor` | `.pi/logs/monitor` | `wait-monitor` |
| task-efficiency | `pi-task-efficiency` | `task-efficiency` | `task_efficiency_*` | `task-efficiency:*` | `analyze-task-efficiency` |
| subagents | `pi-subagents` | `subagents:*` | `subagent` | `subagents:*` | `orchestrate-subagents` |

## Development

```bash
npm install
npm run verify       # typecheck + lint + tests + doc links + packed contents
npm run typecheck
npm run lint
npm test
npm run test:contracts # real producer-to-consumer compatibility checks
npm run check:docs
```

Use the Node version from `.node-version` for development (for example `nvm use` or `fnm use`). Node 22.19 remains the minimum supported version. `npm run verify` is the same entry point CI uses; CI runs it on both the `.node-version` runtime and Node 22.19, the minimum version declared in `engines`. Verify a single package:

```bash
npm test -w @yefengr/pi-monitor
npm run typecheck -w @yefengr/pi-notify
```

Inspect the published tarball before releasing:

```bash
npm pack --dry-run -w @yefengr/pi-notify
```

### Shared engineering conventions

All packages inherit TypeScript options from `tsconfig.base.json` and lint rules from the root `biome.json`. Package configurations keep only local file scopes, aliases, and required interoperability options. Every workspace exposes `typecheck` and `lint`; lint does not format source files. `pi-subagents` additionally retains import organization checks.

Keep Pi registration, lifecycle wiring, and UI at the extension boundary; separate business logic from those adapters where the package's complexity warrants it. This is a shared dependency direction, not a mandatory directory template: lightweight notification handlers, the monitor engine, the review pipeline, and the subagent runtime retain their own structures and test runners.

Cross-package record changes must update their consumers and the tests in `scripts/contracts/`. These tests call the actual producer and consume its serialized output; they run through `npm test` and CI's existing `npm run verify`. Historical lifecycle v2 and current v3 records are both readable by task-efficiency, without adding a runtime dependency on subagents. Repository-only TypeScript configurations are not shipped in extension tarballs.

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

For unpublished candidates, the reusable CI checks run on both the `.node-version` runtime and Node 22.19, the minimum supported version. Each package's existing `prepublishOnly` checks and `npm pack` (including `prepack`) then run on the `.node-version` runtime. A separate OIDC job validates the uploaded tarball's identity and submits that tarball with `npm stage publish`; it does not install dependencies or run package lifecycle scripts.

After a successful staging run, a `tag` job creates the annotated tag `<package-directory>-v<version>` (for example `pi-notify-v0.3.4`) on the release commit. It holds only `contents: write`, separately from the `id-token: write` used by the staging job. If the job fails, create an annotated tag at that commit by hand; do not rerun the release workflow, because that would stage the same version again. The scheduled release workflow creates the GitHub Release after npm approval.

**Successful staging is not a public release.** Open npmjs.com **Staged Packages**, review the pending package, and approve it with 2FA to make it public. A workflow that skips all versions stages nothing.

After approval, `.github/workflows/github-release.yml` checks npm every 30 minutes (at minute 7 and 37) and creates the GitHub Release once the version is public. A version still awaiting approval is skipped until a later run. The workflow never creates tags. If a version is public but its tag is missing, a scheduled run records a warning and skips it so existing versions do not fail every 30 minutes; a manual run fails and asks you to create the tag by hand. Run it manually with the `version` input to backfill a historical release; create the annotated tag at that version's release commit first.

To retry a single package, run the **Release** workflow manually on `main` and select its package name. Other branches are rejected, and already-public versions are skipped. If that version is still awaiting approval, another staging attempt may fail: check the existing Staged Packages entry and approve it, or reject the old entry before retrying. The workflow never automatically approves or replaces pending entries.

If staging fails with `ENEEDAUTH`, the stage job first reports whether the OIDC endpoint was present. A missing endpoint means the job lost `id-token: write` or did not run from `main`; an `oidc` message in the verbose npm log means the registry rejected the exchange, so recheck the Trusted Publisher owner, repository, and workflow filename.

This flow does not update installed Pi copies or deploy a server. It does create the release tags and GitHub Releases described above. If a package was published under a name that was later reverted, mark the old name with `npm deprecate` pointing to the current package.

## License

MIT, except [`packages/pi-subagents`](./packages/pi-subagents), which retains the upstream `tintinweb` MIT copyright notice. See [LICENSE](./LICENSE).
