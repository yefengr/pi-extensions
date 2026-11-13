# Changelog

## 0.3.0

- Make `/worktree:switch` restore an existing workspace session with its original identity and conversation instead of copying the current session. Offer a session selector when several histories exist and an explicit `sessionId` for scripted calls.
- Remove the Ctrl+Alt+W shortcut; workspace selection remains available through `/worktree:switch`.
- Document the deferred migration failure when a newly allocated source session path has not yet been saved to disk.

## 0.2.0

- Add native Windows 10/11 support for worktree creation, switching, migration, listing, and removal through Node.js APIs and Git argv calls, with no Shell creator or extra runtime dependency.
- Replace the bundled `create-worktree.sh` with an in-package TypeScript implementation; on Windows, project setup hooks are rejected explicitly before any worktree state is created rather than silently skipped.
- Reject Windows device names such as `con`, `nul`, and `com1`, and document hook stages, environment variables, timeouts, and cancellation behavior.

## 0.1.2

- Show temporary native progress during worktree creation, switching, migration, and removal, including actual elapsed time and batch target counts.
- Report removal stages through tool updates even without UI support, while preserving final structured results and existing safety checks.
- Clear progress on completion, failure, cancellation, and session replacement without updating stale UI contexts.

## 0.1.1

- Prepare a patch release for the configured GitHub Actions trusted-publishing workflow with npm provenance.
- Keep runtime behavior, command names, and existing worktree data unchanged.

## 0.1.0

- Package the existing managed-worktree extension as `@yefengr/pi-worktree`.
- Expose `worktree:create`, `worktree:switch`, `worktree:migrate`, `worktree:list`, and `worktree:remove`; keep the `worktree_*` tools and Ctrl+Alt+W shortcut.
- Preserve persistent session migration, native footer updates, automatic one-time continuation, and safe worktree and branch removal.
- Keep the existing `pi-worktree-manager.json` ownership format so previously managed worktrees remain recognized.
