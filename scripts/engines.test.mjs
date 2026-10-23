import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PACKAGES } from "./release.mjs";

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
