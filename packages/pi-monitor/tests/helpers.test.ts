import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const HELPERS = new URL("./helpers.ts", import.meta.url).href;

/** 合成宿主只导出 ESM 条件，并带上项目开发依赖不具备的标识。 */
function writeHostPackage(packageDir: string, name: string, marker: string): void {
  mkdirSync(path.join(packageDir, "dist"), { recursive: true });
  writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
    name, version: "0.0.0", type: "module", exports: { ".": { import: "./dist/index.js" } },
  }));
  writeFileSync(path.join(packageDir, "dist", "index.js"), `export const marker = ${JSON.stringify(marker)};\n`);
}

test("installHostAliases 按所选宿主解析 SDK、TUI 与 typebox", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "monitor-host-alias-"));
  try {
    const modules = path.join(fixture, "node_modules");
    const sdkRoot = path.join(modules, "@earendil-works", "pi-coding-agent");
    writeHostPackage(sdkRoot, "@earendil-works/pi-coding-agent", "synthetic-sdk");
    writeHostPackage(path.join(modules, "@earendil-works", "pi-tui"), "@earendil-works/pi-tui", "synthetic-tui");
    writeHostPackage(path.join(modules, "typebox"), "typebox", "synthetic-typebox");
    const script = [
      `const { installHostAliases } = await import(${JSON.stringify(HELPERS)});`,
      "installHostAliases();",
      'const markers = [];',
      'for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {',
      "  markers.push((await import(name)).marker);",
      "}",
      "console.log(JSON.stringify(markers));",
    ].join("\n");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      env: { ...process.env, PI_MONITOR_PI_ROOT: sdkRoot },
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const markers = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "");
    assert.deepEqual(markers, ["synthetic-sdk", "synthetic-tui", "synthetic-typebox"]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
