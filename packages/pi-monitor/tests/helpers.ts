import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { MonitorDefinition } from "../src/types.ts";

export function definition(overrides: Partial<MonitorDefinition> = {}): MonitorDefinition {
  return {
    id: "task-1", ownerSessionId: "owner-1", name: "测试监听", purpose: "等待测试事件",
    explanation: "只解释", mode: "continuous", delivery: "explain", command: process.execPath,
    args: [], cwd: process.cwd(), intervalMs: 60_000, timeoutMs: 500,
    createdAt: Date.now(), logLevel: "info", ...overrides,
  };
}

export function installedPiRoot(): string {
  if (process.env.PI_MONITOR_PI_ROOT) return process.env.PI_MONITOR_PI_ROOT;
  try {
    // 包只导出 import 条件，从 ESM 主入口反推包根。
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const root = path.resolve(path.dirname(entry), "..");
    if (existsSync(path.join(root, "dist", "cli.js"))) return root;
  } catch { /* 尝试官方安装器。 */ }
  const install = path.join(homedir(), ".pi", "agent", "install");
  const versionFile = path.join(install, "current-version");
  if (existsSync(versionFile)) {
    const version = readFileSync(versionFile, "utf8").trim();
    const root = path.join(install, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
    if (existsSync(path.join(root, "package.json"))) return root;
  }
  const root = path.resolve(path.dirname(process.execPath), "../lib/node_modules/@earendil-works/pi-coding-agent");
  if (existsSync(path.join(root, "package.json"))) return root;
  throw new Error("集成测试需要已安装的 Pi；可用 PI_MONITOR_PI_ROOT 指定 package 根目录");
}

export function piCliPath(): string | null {
  try {
    const cli = path.join(installedPiRoot(), "dist", "cli.js");
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

export function installHostAliases(): void {
  const root = installedPiRoot();
  const resolveEsm = (specifier: string) => fileURLToPath(import.meta.resolve(specifier));
  const aliases: Record<string, string> = {
    typebox: resolveEsm("typebox"),
    "@earendil-works/pi-tui": resolveEsm("@earendil-works/pi-tui"),
    "@earendil-works/pi-coding-agent": path.join(root, "dist", "index.js"),
  };
  registerHooks({ resolve(specifier, context, next) {
    const target = aliases[specifier];
    return target ? { url: pathToFileURL(target).href, shortCircuit: true } : next(specifier, context);
  } });
}

export async function eventually(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("等待测试条件超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
