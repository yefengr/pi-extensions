import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { CommandRunner, WorktreeRecord } from "./worktree-types.ts";
import { isStrictlyWithin } from "./worktree-utils.ts";

export const OWNERSHIP_MARKER_FILENAME = "pi-worktree-manager.json";
const OWNERSHIP_MARKER_SCHEMA_VERSION = 1;
const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface OwnershipMarker {
  schemaVersion: 1;
  createdAt: string;
}

/**
 * 严格校验专属所有权标记：只接受 schemaVersion=1 与 ISO 8601 创建时间；
 * 缺失、损坏或版本不符都视为“不属于 Pi 管理”。
 */
function parseOwnershipMarker(raw: string): OwnershipMarker | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== OWNERSHIP_MARKER_SCHEMA_VERSION) return undefined;
  const createdAt = record.createdAt;
  if (typeof createdAt !== "string" || !ISO_8601_PATTERN.test(createdAt)) return undefined;
  if (Number.isNaN(Date.parse(createdAt))) return undefined;
  return { schemaVersion: OWNERSHIP_MARKER_SCHEMA_VERSION, createdAt };
}

/** 从 Git linked-worktree 管理目录读取标记；记录不可读或标记无效时返回 undefined。 */
export async function readOwnershipMarker(
  worktreePath: string,
  runner: CommandRunner,
): Promise<OwnershipMarker | undefined> {
  let gitDir: string;
  try {
    const result = await runner.run("git", [
      "-C",
      worktreePath,
      "rev-parse",
      "--absolute-git-dir",
    ]);
    if (result.code !== 0) return undefined;
    gitDir = result.stdout.trim();
  } catch {
    return undefined;
  }
  if (!gitDir) return undefined;

  try {
    return parseOwnershipMarker(await readFile(path.join(gitDir, OWNERSHIP_MARKER_FILENAME), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * 只保留指定仓库登记、位于当前 Pi 根目录且带有效所有权标记的非主、非 bare linked worktree，
 * 并按 createdAt 从新到旧排序；时间相同时按路径稳定排序。
 */
export async function collectOwnedWorktrees(
  records: WorktreeRecord[],
  sourceRoot: string,
  worktreeRoot: string,
  runner: CommandRunner,
): Promise<WorktreeRecord[]> {
  const owned: WorktreeRecord[] = [];
  for (const record of records) {
    if (record.bare || record.prunable) continue;

    let targetPath: string;
    try {
      targetPath = await realpath(record.path);
    } catch {
      continue;
    }
    if (samePath(targetPath, sourceRoot) || !isStrictlyWithin(worktreeRoot, targetPath)) continue;

    const marker = await readOwnershipMarker(targetPath, runner);
    if (!marker) continue;
    owned.push({
      ...record,
      createdAt: marker.createdAt,
      lastCommitAt: await readLastCommitAt(targetPath, record.head, runner),
    });
  }
  return owned.sort(compareOwnedWorktrees);
}

export async function readLastCommitAt(
  worktreePath: string,
  head: string | undefined,
  runner: CommandRunner,
): Promise<string | undefined> {
  if (!head) return undefined;
  const result = await runner.run("git", ["-C", worktreePath, "show", "-s", "--format=%cI", head]);
  const timestamp = result.stdout.trim();
  return result.code === 0 && timestamp && !Number.isNaN(Date.parse(timestamp))
    ? timestamp
    : undefined;
}

function compareOwnedWorktrees(left: WorktreeRecord, right: WorktreeRecord): number {
  const leftTime = Date.parse(left.createdAt ?? "");
  const rightTime = Date.parse(right.createdAt ?? "");
  if (leftTime !== rightTime) return rightTime - leftTime;
  if (left.path === right.path) return 0;
  return left.path < right.path ? -1 : 1;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}
