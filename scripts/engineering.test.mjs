import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import ts from "typescript";

import { PACKAGES } from "./release.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SHARED_OPTIONS = [
  "target", "module", "moduleResolution", "strict", "noEmit",
  "allowImportingTsExtensions", "skipLibCheck", "forceConsistentCasingInFileNames", "types",
];

async function json(file) {
  return JSON.parse(await readFile(path.join(ROOT, file), "utf8"));
}

test("全部发布包继承共享 TypeScript 选项且保留有效的本地文件范围", async () => {
  const base = await json("tsconfig.base.json");
  const expected = ts.convertCompilerOptionsFromJson(base.compilerOptions, ROOT);
  assert.deepEqual(expected.errors, []);
  for (const { directory } of PACKAGES) {
    const configPath = path.join(ROOT, "packages", directory, "tsconfig.json");
    const config = await json(path.relative(ROOT, configPath));
    assert.equal(config.extends, "../../tsconfig.base.json", directory);
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => assert.fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    });
    assert.ok(parsed, directory);
    assert.deepEqual(parsed.errors, [], directory);
    for (const option of SHARED_OPTIONS) assert.deepEqual(parsed.options[option], expected.options[option], `${directory}: ${option}`);
    assert.ok(parsed.fileNames.some((file) => file.endsWith("/index.ts")), directory);
    assert.ok(parsed.fileNames.some((file) => file.endsWith(".test.ts")), directory);
  }
});

test("所有包的 lint 都实际应用公共规则，不因局部配置或新增包而漏检", async () => {
  const rootPackage = await json("package.json");
  const biome = await json("biome.json");
  assert.equal(biome.formatter.enabled, false);
  assert.match(rootPackage.scripts.lint, /biome check scripts/);
  assert.match(rootPackage.scripts.lint, /npm run lint --workspaces(?:$|\s)/);
  assert.equal(rootPackage.scripts.lint.includes("--if-present"), false);
  for (const { directory } of PACKAGES) {
    const pkg = await json(`packages/${directory}/package.json`);
    assert.equal(pkg.scripts.lint, "biome check .", directory);
    const fixture = path.join(ROOT, "packages", directory, `lint-contract-${randomUUID()}.ts`);
    await writeFile(fixture, "const values = [1];\nvalues.forEach((value) => values.push(value));\n", { flag: "wx" });
    try {
      const result = spawnSync(path.join(ROOT, "node_modules", ".bin", "biome"), ["check", fixture], {
        cwd: ROOT,
        encoding: "utf8",
      });
      assert.ifError(result.error);
      assert.equal(result.status, 1, `${directory}: lint 必须拒绝有副作用返回值的 forEach`);
      assert.match(result.stdout + result.stderr, /lint\/suspicious\/useIterableCallbackReturn/, directory);
    } finally {
      await rm(fixture, { force: true });
    }
  }
});

test("跨包契约测试进入默认 test/verify，仓库配置不作为扩展运行时资产发布", async () => {
  const rootPackage = await json("package.json");
  assert.match(rootPackage.scripts.test, /npm run test:contracts/);
  assert.match(rootPackage.scripts["test:contracts"], /--experimental-strip-types --test scripts\/contracts\/\*\.test\.mjs/);
  assert.match(rootPackage.scripts.verify, /npm test/);
  for (const { directory } of PACKAGES) {
    const pkg = await json(`packages/${directory}/package.json`);
    assert.equal(pkg.files.includes("tsconfig.json"), false, directory);
  }
});
