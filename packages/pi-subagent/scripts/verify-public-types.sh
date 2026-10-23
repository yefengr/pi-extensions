#!/usr/bin/env bash
# Verify that the packed declarations are self-contained and consumable without
# repository-local path aliases or workspace privileges.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

TARBALL_NAME="$(npm --prefix "$PKG_DIR" pack --pack-destination "$WORK" --silent)"
TARBALL="$WORK/$TARBALL_NAME"
echo "Packed: $TARBALL_NAME"

DTS="$PKG_DIR/dist/public.d.ts"
if grep -q '#src' "$DTS"; then
  echo "FAIL: dist/public.d.ts still references #src/*" >&2
  grep -n '#src' "$DTS" >&2
  exit 1
fi
for sym in getSubagentsService WorkspaceProvider SubagentsService SubagentRecord SubagentInvocationIdentity LifetimeUsage Workspace WorkspacePrepareContext WorkspaceDisposeOutcome WorkspaceDisposeResult; do
  grep -q "$sym" "$DTS" || { echo "FAIL: '$sym' missing from dist/public.d.ts" >&2; exit 1; }
done

echo "OK: public declaration is self-contained"

SETTINGS_DTS="$PKG_DIR/dist/settings.d.ts"
if grep -q '#src' "$SETTINGS_DTS"; then
  echo "FAIL: dist/settings.d.ts still references #src/*" >&2
  grep -n '#src' "$SETTINGS_DTS" >&2
  exit 1
fi
for sym in loadLayeredSettings LayeredSettingsSource; do
  grep -q "$sym" "$SETTINGS_DTS" || { echo "FAIL: '$sym' missing from dist/settings.d.ts" >&2; exit 1; }
done

echo "OK: settings declaration is self-contained"

CONSUMER="$WORK/consumer"
mkdir -p "$CONSUMER"

cat > "$CONSUMER/package.json" <<'JSON'
{ "name": "consumer", "version": "0.0.0", "private": true, "type": "module" }
JSON

cat > "$CONSUMER/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["probe.ts", "probe-settings.ts"]
}
JSON

cat > "$CONSUMER/probe.ts" <<'TS'
import {
  getSubagentsService,
  type Workspace,
  type WorkspaceDisposeOutcome,
  type WorkspaceDisposeResult,
  type SubagentInvocationIdentity,
  type SubagentRecord,
  type WorkspacePrepareContext,
  type WorkspaceProvider,
} from "@yefengr/pi-subagent";

const provider: WorkspaceProvider = {
  async prepare(ctx: WorkspacePrepareContext): Promise<Workspace | undefined> {
    return {
      cwd: ctx.baseCwd,
      dispose(_outcome: WorkspaceDisposeOutcome): WorkspaceDisposeResult | undefined {
        return undefined;
      },
    };
  },
};

const invocation: SubagentInvocationIdentity = {
  kind: "resume",
  source: "tool",
  toolCallId: "tool-call-id",
};
const record = getSubagentsService()?.getRecord("agent-id");
if (record) {
  const typedRecord: SubagentRecord = record;
  void typedRecord.sessionId;
  void typedRecord.invocationUsage;
}

void invocation;
void provider;
TS

cat > "$CONSUMER/probe-settings.ts" <<'TS'
import { loadLayeredSettings, type LayeredSettingsSource } from "@yefengr/pi-subagent/settings";

interface MyConfig { enabled?: boolean; limit?: number }

function sanitize(raw: unknown): Partial<MyConfig> {
  if (!raw || typeof raw !== "object") return {};
  const record = raw as Record<string, unknown>;
  const output: Partial<MyConfig> = {};
  if (typeof record.enabled === "boolean") output.enabled = record.enabled;
  if (typeof record.limit === "number") output.limit = record.limit;
  return output;
}

const source: LayeredSettingsSource<MyConfig> = {
  agentDir: "/tmp/agent",
  cwd: "/tmp/project",
  filename: "my-extension.json",
  sanitize,
  warnLabel: "my-extension",
};

const config: Partial<MyConfig> = loadLayeredSettings(source);
void config;
TS

npm install --prefix "$CONSUMER" --ignore-scripts --no-audit --no-fund \
  "$TARBALL" \
  "@earendil-works/pi-ai@1.4.0" \
  "@earendil-works/pi-coding-agent@1.4.0" \
  "@earendil-works/pi-tui@1.4.0" \
  "typebox@1.3.7" \
  >/dev/null

"$PKG_DIR/node_modules/.bin/tsc" -p "$CONSUMER/tsconfig.json"
echo "OK: external consumer type-checks against packed @yefengr/pi-subagent"
