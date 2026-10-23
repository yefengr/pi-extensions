import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

test("各包使用稳定根入口、src 实现和完整的 tests 类型检查范围", async () => {
  for (const { directory } of PACKAGES) {
    const packageDir = path.join(ROOT, "packages", directory);
    const entries = await readdir(packageDir, { withFileTypes: true });
    const rootSources = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".config.ts")).map((entry) => entry.name);
    assert.deepEqual(rootSources, ["index.ts"], directory);
    for (const legacy of ["core", "extension", "platforms", "tui", "test"]) {
      assert.equal(entries.some((entry) => entry.isDirectory() && entry.name === legacy), false, `${directory}: ${legacy}`);
    }
    const pkg = await json(`packages/${directory}/package.json`);
    assert.deepEqual(pkg.pi.extensions, ["./index.ts"], directory);
    assert.ok(pkg.files.includes("src"), directory);
    const parsed = ts.getParsedCommandLineOfConfigFile(path.join(packageDir, "tsconfig.json"), {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => assert.fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    });
    assert.ok(parsed, directory);
    const included = new Set(parsed.fileNames.map((file) => path.resolve(file)));
    for (const folder of ["src", "tests"]) {
      const files = await readdir(path.join(packageDir, folder), { recursive: true });
      assert.ok(files.some((file) => file.endsWith(".ts")), `${directory}/${folder}`);
      for (const file of files.filter((file) => file.endsWith(".ts"))) {
        assert.equal(included.has(path.join(packageDir, folder, file)), true, `${directory}/${folder}/${file}`);
      }
      assert.equal(files.some((file) => file.split(path.sep).includes("__tests__")), false, directory);
    }
  }
});

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 60_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function exportPaths(value) {
  if (typeof value === "string") return [value];
  return Object.values(value).flatMap(exportPaths);
}

test("真实 tarball 包含完整公开入口，排除测试，并可由 Pi 一起加载", async () => {
  const sdkName = "@earendil-works/pi-coding-agent";
  const sdkHost = path.join(ROOT, "packages", "pi-notify", "package.json");
  const sdkMetadata = JSON.parse(await readFile(sdkHost, "utf8"));
  assert.ok(sdkMetadata.devDependencies?.[sdkName], "SDK 必须由用于解析的 workspace 显式声明");
  // 由声明依赖的 workspace 内的 ESM 辅助文件加载，兼容仅提供 import 导出的 SDK 与嵌套安装。
  const { createEventBus, DefaultResourceLoader, SettingsManager } = await import("../packages/pi-notify/tests/pi-sdk.mjs");
  const temporaryRoot = path.join(ROOT, ".pi", "tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const sandbox = await mkdtemp(path.join(temporaryRoot, "directory-layout-"));
  try {
    const extensionPaths = [];
    let notifyPackage;
    for (const { directory, name } of PACKAGES) {
      const [packed] = JSON.parse(run("npm", ["pack", "--json", "--workspace", name, "--pack-destination", sandbox], ROOT));
      const expected = await json(`packages/${directory}/package.json`);
      assert.equal(packed.name, name, directory);
      assert.equal(packed.version, expected.version, directory);
      const files = new Set(packed.files.map(({ path: file }) => file));
      assert.equal([...files].some((file) => /(^|\/)(tests?|__tests__)(\/|$)/.test(file)), false, directory);
      assert.equal(files.has("tsconfig.json"), false, directory);
      for (const entry of ["index.ts", ...exportPaths(expected.exports ?? {}), ...(expected.main ? [expected.main] : [])]) {
        assert.equal(files.has(entry.replace(/^\.\//, "")), true, `${directory}: ${entry}`);
      }
      const sourceFiles = await readdir(path.join(ROOT, "packages", directory, "src"), { recursive: true });
      for (const file of sourceFiles.filter((file) => file.endsWith(".ts"))) {
        assert.equal(files.has(`src/${file.split(path.sep).join("/")}`), true, `${directory}/src/${file}`);
      }
      const extracted = path.join(sandbox, directory);
      await mkdir(extracted);
      run("tar", ["-xzf", path.join(sandbox, packed.filename), "-C", extracted], ROOT);
      const packageDir = path.join(extracted, "package");
      extensionPaths.push(path.join(packageDir, "index.ts"));
      if (directory === "pi-notify") notifyPackage = { directory: packageDir, version: expected.version };
    }
    const cwd = path.join(sandbox, "workspace");
    const agentDir = path.join(sandbox, "agent");
    await mkdir(cwd);
    await mkdir(agentDir);
    const eventBus = createEventBus();
    const ready = [];
    eventBus.on("notify:module-ready", (payload) => { ready.push(payload); });
    const loader = new DefaultResourceLoader({
      cwd, agentDir, eventBus,
      settingsManager: SettingsManager.inMemory({ packages: [] }),
      additionalExtensionPaths: extensionPaths,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.extensions.map(({ resolvedPath }) => resolvedPath).sort(), [...extensionPaths].sort());
    assert.ok(notifyPackage);
    const notify = loaded.extensions.find(({ resolvedPath }) => resolvedPath === path.join(notifyPackage.directory, "index.ts"));
    assert.ok(notify);
    assert.ok(notify.tools.has("notify_user"));
    const sessionStart = notify.handlers.get("session_start");
    assert.ok(sessionStart?.length);
    // 只触发 notify 的就绪事件，不启动其他扩展会话、执行工具、发送通知或请求模型。
    for (const handler of sessionStart) await handler({ type: "session_start", reason: "startup" }, {});
    assert.equal(ready.length, 1);
    assert.equal(ready[0].version, notifyPackage.version);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
