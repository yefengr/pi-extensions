import { realpathSync } from "node:fs";
import path from "node:path";

/** 已存在路径先消除 symlink/junction；不折叠目录大小写，保留大小写敏感卷的边界。 */
export function canonicalPath(value: string): string {
  let resolved = path.resolve(value);
  try { resolved = realpathSync.native(resolved); } catch { /* 尚不存在的目标使用词法路径。 */ }
  return normalizeIdentity(resolved);
}

function normalizeIdentity(value: string, api: path.PlatformPath = path): string {
  const normalized = api.normalize(value);
  return api === path.win32 || (api === path && process.platform === "win32")
    ? normalized.replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
    : normalized;
}

export function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

export function isStrictlyWithin(parent: string, candidate: string): boolean {
  const root = canonicalPath(parent);
  const target = canonicalPath(candidate);
  return isLexicallyWithin(root, target);
}

/** 纯路径校验供尚不存在的目标使用；可用 win32 API 独立覆盖跨盘和 UNC 边界。 */
export function isLexicallyWithin(parent: string, candidate: string, api: path.PlatformPath = path): boolean {
  const root = normalizeIdentity(api.resolve(parent), api);
  const target = normalizeIdentity(api.resolve(candidate), api);
  const relative = api.relative(root, target);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${api.sep}`)
    && !api.isAbsolute(relative)
    // win32.relative 会折叠目录大小写；不能把大小写敏感卷上的同名相邻目录视为父子。
    && normalizeIdentity(api.resolve(root, relative), api) === target;
}

export function isWindowsReservedName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}
