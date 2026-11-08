import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PACKAGES } from "./release.mjs";

test("Windows package jobs share Node limits and participate in the reusable required gate", async () => {
  const root = JSON.parse(await readFile("package.json", "utf8"));
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  const windows = /^  windows:[\s\S]*?(?=^  verify:)/m.exec(workflow)?.[0];
  assert.ok(windows, "Windows checks must not be a separate optional workflow");
  assert.match(windows, /runs-on: windows-/);
  assert.match(windows, /runtime: \[primary, minimum\]/);
  assert.match(windows, /node-version-file: \.node-version/);
  assert.equal(/node-version: "([^"]+)"/.exec(windows)?.[1], root.engines.node.replace(/^>=/, ""));
  for (const script of ["typecheck", "lint"]) {
    assert.ok(windows.includes(`npm run ${script} -w @yefengr/pi-monitor -w @yefengr/pi-worktree`));
  }
  assert.ok(windows.includes("npm test -w @yefengr/pi-monitor -w @yefengr/pi-worktree"));
  const gate = /^  verify:[\s\S]*$/m.exec(workflow)?.[0] ?? "";
  assert.match(gate, /needs: \[[^\]]*windows[^\]]*\]/);
  assert.ok(gate.includes("WINDOWS: ${{ needs.windows.result }}"));
  assert.ok(gate.includes('test "$WINDOWS" = success'));
  const release = await readFile(".github/workflows/release.yml", "utf8");
  assert.match(release, /uses: \.\/\.github\/workflows\/ci\.yml/);
});

test("CI compat job and package engines share the minimum Node version", async () => {
  const root = JSON.parse(await readFile("package.json", "utf8"));
  const expected = root.engines.node.replace(/^>=/, "");
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  const compat = /name: compat[\s\S]*?node-version: "([^"]+)"/.exec(workflow);
  assert.ok(compat, "compat job must pin a Node version");
  assert.equal(compat[1], expected, "compat job must match the root engines lower bound");
  for (const { directory } of PACKAGES) {
    const pkg = JSON.parse(await readFile(`packages/${directory}/package.json`, "utf8"));
    assert.equal(pkg.engines?.node, root.engines.node, `${directory} engines must match the root`);
  }
});
