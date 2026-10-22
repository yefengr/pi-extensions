import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
  const require = createRequire(import.meta.url);
  try { return path.dirname(require.resolve("@earendil-works/pi-coding-agent/package.json")); } catch { /* 尝试官方安装器。 */ }
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

export function installHostAliases(): void {
  const root = installedPiRoot();
  const require = createRequire(path.join(root, "package.json"));
  const aliases: Record<string, string> = {
    typebox: require.resolve("typebox"),
    "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
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
