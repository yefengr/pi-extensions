# Changelog

## 0.1.1

- Prepare a patch release for the configured GitHub Actions trusted-publishing workflow with npm provenance.
- Keep runtime behavior, command names, and existing worktree data unchanged.

## 0.1.0

- Package the existing managed-worktree extension as `@yefengr/pi-worktree`.
- Expose `worktree:create`, `worktree:switch`, `worktree:migrate`, `worktree:list`, and `worktree:remove`; keep the `worktree_*` tools and Ctrl+Alt+W shortcut.
- Preserve persistent session migration, native footer updates, automatic one-time continuation, and safe worktree and branch removal.
- Keep the existing `pi-worktree-manager.json` ownership format so previously managed worktrees remain recognized.
