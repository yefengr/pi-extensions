import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findBrokenLinks, headingAnchors } from "./check-doc-links.mjs";

test("derives GitHub-style heading anchors for Chinese, code spans, and duplicates", () => {
  const anchors = headingAnchors([
    "# Pi Extensions",
    "## 安全模型",
    "## Trust model",
    "### `Host`",
    "## Trust model",
    "```",
    "# not a heading",
    "```",
  ].join("\n"));
  assert.deepEqual([...anchors].sort(), ["host", "pi-extensions", "trust-model", "trust-model-1", "安全模型"].sort());
});

test("reports missing files and anchors in titled and angle-bracket links, ignoring external, site-absolute, and fenced links", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extensions-doc-links-"));
  try {
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "guide.md"), "# Guide\n\n## 安装步骤\n");
    await writeFile(join(root, "README.md"), [
      "# Readme",
      "[ok](docs/guide.md#安装步骤)",
      "[same file](#readme)",
      "[query](docs/guide.md?view=raw)",
      "[external](https://example.com/missing.md)",
      "[route](/app/settings)",
      "[missing file](docs/nope.md)",
      "[missing anchor](docs/guide.md#nope)",
      '[titled ok](docs/guide.md#安装步骤 "Guide")',
      "[titled missing](docs/titled.md 'Title')",
      "[angle missing](<docs/with space.md>)",
      "[escape](../outside.md)",
      "[ref ok][guide]",
      "[ref missing][missing-ref]",
      "[guide]: docs/guide.md#安装步骤",
      "[missing-ref]: docs/ref-missing.md",
      '<img src="docs/missing.png" alt="" />',
      "```",
      "[fenced](docs/also-missing.md)",
      "```",
    ].join("\n"));

    const broken = findBrokenLinks(root, ["README.md", "docs/guide.md"]);

    assert.deepEqual(broken.sort(), [
      "README.md: escapes repository ../outside.md",
      "README.md: missing anchor docs/guide.md#nope",
      "README.md: missing docs/missing.png",
      "README.md: missing docs/nope.md",
      "README.md: missing docs/ref-missing.md",
      "README.md: missing docs/titled.md",
      "README.md: missing docs/with space.md",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
