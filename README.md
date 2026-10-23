# pi-extensions

[Pi](https://pi.dev) extensions maintained by [yefengr](https://github.com/yefengr). Each package is an independent npm package and can be installed on its own.

## Packages

| Package | Description | Status |
|---|---|---|
| [`@yefengr/pi-notify`](./packages/pi-notify) | Desktop notifications through native terminal OSC protocols, with no system notification helper | Published |
| [`@yefengr/pi-watch`](./packages/pi-watch) | Background command monitoring with one-shot or continuous checks, notification-only or explained delivery | Published |
| [`@yefengr/pi-efficiency`](./packages/pi-efficiency) | Task efficiency review with scope confirmation, deterministic metrics, and actionable suggestions | Published |
| [`@yefengr/pi-subagent`](./packages/pi-subagent) | In-process subagent runtime with background execution, steering, resume, and lifecycle events | Published |

## Install

Requires Pi 1.x and Node.js >= 22.19.0.

```bash
pi install npm:@yefengr/pi-watch
pi install npm:@yefengr/pi-notify
```

Run `/reload` or restart Pi after installation. Remove a package with:

```bash
pi remove npm:@yefengr/pi-watch
```

## Development

```bash
npm install
npm run typecheck
npm test
```

Verify a single package:

```bash
npm test -w @yefengr/pi-watch
npm run typecheck -w @yefengr/pi-notify
```

Inspect the published tarball before releasing:

```bash
npm pack --dry-run -w @yefengr/pi-notify
```

## Publishing

Releases use manual semantic versioning. The first version of each package was published from a 2FA-authenticated terminal; later versions can use npm Trusted Publishing (GitHub Actions OIDC) through `.github/workflows/release.yml` once the publisher is configured on npmjs.com.

## License

MIT, except [`packages/pi-subagent`](./packages/pi-subagent), which retains the upstream `tintinweb` MIT copyright notice. See [LICENSE](./LICENSE).
