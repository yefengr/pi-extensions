import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { piCli, piPackage } from "./pi-sdk.mjs";

const root = path.resolve(import.meta.dirname, "..");
const sandbox = mkdtempSync(path.join(tmpdir(), "pi-worktree-smokes-"));
const scenarios = [
  ["tool-smoke.mjs"],
  ["tool-smoke.mjs", [], { DEFAULT_REPO_PATH: "1" }],
  ["tool-handoff-smoke.mjs"],
  ["switch-smoke.mjs"],
  ["interactive-smoke.mjs"],
  ...["persistent", "ephemeral", "after-failure", "default-repo-path", "default-repo-list",
    "migrate-no-worktree-path", "remove-default", "remove-keep"].map((scenario) => ["rpc-smoke.mjs", [scenario]]),
  ["auto-switch.integration.mjs"],
];

try {
  for (const [index, [file, args = [], extra = {}]] of scenarios.entries()) {
    const fixture = path.join(sandbox, String(index));
    mkdirSync(fixture);
    const env = {
      ...extra,
      FIXTURE: fixture,
      EXTENSION: path.join(root, "index.ts"),
      PI_PACKAGE: piPackage,
      PI_CLI: piCli,
      PI_CODING_AGENT_DIR: path.join(fixture, "agent"),
      PI_CODING_AGENT_SESSION_DIR: path.join(fixture, "sessions"),
    };
    console.log(`smoke: ${file} ${args.join(" ")}`);
    run(process.execPath, [path.join(root, "tests", file), ...args], env);
  }
  console.log(`passed ${scenarios.length} isolated smoke scenarios`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: path.join(sandbox, "shell-agent"), ...env },
    encoding: "utf8", timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed`);
}
