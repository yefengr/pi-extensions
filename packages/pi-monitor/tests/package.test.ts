import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { definition, installedPiRoot } from "./helpers.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test("real Monitor tarball loads in Pi and runs the packaged executor", { timeout: 90_000 }, async () => {
  const npm = process.env.npm_execpath;
  assert.ok(npm, "请通过 npm test 运行打包测试，使 Windows 也使用 Node/npm CLI 入口");
  const temporaryRoot = path.join(ROOT, ".pi", "tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const sandbox = await mkdtemp(path.join(temporaryRoot, "monitor-packed-"));
  try {
    const [packed] = JSON.parse(run(process.execPath, [npm, "pack", "--json", "--workspace", "@yefengr/pi-monitor", "--pack-destination", sandbox], ROOT));
    const files = new Set<string>(packed.files.map((entry: { path: string }) => entry.path));
    assert.equal(files.has("index.ts"), true);
    assert.equal(files.has("src/process-backend.ts"), true);
    assert.equal([...files].some((file) => /(^|\/)tests?(\/|$)/.test(file)), false);
    const sourceFiles = await readdir(path.join(ROOT, "packages/pi-monitor/src"), { recursive: true });
    for (const file of sourceFiles.filter((file) => file.endsWith(".ts"))) assert.equal(files.has(`src/${file.split(path.sep).join("/")}`), true, file);
    run("tar", ["-xzf", path.join(sandbox, packed.filename), "-C", sandbox], ROOT);
    const directory = path.join(sandbox, "package");
    const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    const expected = JSON.parse(await readFile(path.join(ROOT, "packages/pi-monitor/package.json"), "utf8"));
    assert.ok(manifest.dependencies["cross-spawn"]);
    assert.equal(manifest.dependencies["cross-spawn"], expected.dependencies["cross-spawn"]);
    const { runCommand } = await import(pathToFileURL(path.join(directory, "src/executor.ts")).href);
    const output = await runCommand(definition({ cwd: sandbox, args: ["-e", "console.log(JSON.stringify({state:'ok',events:[{id:'packed-1',summary:'打包执行成功'}]}))"], timeoutMs: 5_000 }), new AbortController().signal);
    assert.equal(JSON.parse(output).events[0].summary, "打包执行成功");
    const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(path.join(installedPiRoot(), "dist/index.js")).href);
    const loader = new DefaultResourceLoader({
      cwd: sandbox, agentDir: path.join(sandbox, "agent"), settingsManager: SettingsManager.inMemory({ packages: [] }),
      additionalExtensionPaths: [path.join(directory, "index.ts")],
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    assert.ok(loaded.extensions[0].tools.has("monitor"));
  } finally { await rm(sandbox, { recursive: true, force: true }); }
});
