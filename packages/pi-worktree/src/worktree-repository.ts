import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isStrictlyWithin, parseWorktreePorcelain } from "./worktree-utils.ts";
import { WorktreeError } from "./worktree-types.ts";
import type { CommandResult, CommandRunner, WorktreeRecord, WorktreeStage } from "./worktree-types.ts";

export interface DomainOptions {
  runner: CommandRunner;
  creatorPath: string;
  env?: NodeJS.ProcessEnv;
}

interface ResolvedRepository {
  sourceRoot: string;
  records: WorktreeRecord[];
}

export function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new WorktreeError(`${field} 必须是字符串`, "validation");
  }
  const normalized = stripAtPrefix(value).trim();
  if (!normalized) throw new WorktreeError(`${field} 不能为空`, "validation");
  return normalized;
}

function stripAtPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

export async function resolveRepository(repoPath: string, runner: CommandRunner): Promise<ResolvedRepository> {
  let inputPath: string;
  try {
    inputPath = await realpath(stripAtPrefix(repoPath));
  } catch {
    throw new WorktreeError(`仓库路径不存在：${repoPath}`, "repository");
  }

  const records = await readWorktreeRecords(inputPath, runner, "repository");
  const main = records[0];
  if (!main || main.bare) {
    throw new WorktreeError(`无法解析 Git 主工作区：${repoPath}`, "repository");
  }

  let sourceRoot: string;
  try {
    sourceRoot = await realpath(main.path);
  } catch {
    throw new WorktreeError(`Git 主工作区路径不存在：${main.path}`, "repository");
  }

  return { sourceRoot, records };
}

export async function readWorktreeRecords(
  repoPath: string,
  runner: CommandRunner,
  stage: WorktreeStage = "list",
): Promise<WorktreeRecord[]> {
  const result = await runChecked(
    runner,
    "git",
    ["-C", repoPath, "worktree", "list", "--porcelain", "-z"],
    `无法读取 Git 工作树列表：${repoPath}`,
    stage,
  );
  const records = parseWorktreePorcelain(result.stdout);
  if (records.length === 0) {
    throw new WorktreeError(`Git 未返回工作树记录：${repoPath}`, stage);
  }
  return records;
}

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR;
  if (!configured) return path.join(homedir(), ".pi", "agent");

  const expanded = expandHome(configured);
  if (!path.isAbsolute(expanded)) {
    throw new WorktreeError(`PI_CODING_AGENT_DIR 必须是绝对路径：${configured}`, "validation");
  }
  return path.normalize(expanded);
}

export async function resolveWorktreeRoot(
  env: NodeJS.ProcessEnv = process.env,
  create: boolean,
  missingStage: WorktreeStage = create ? "validation" : "remove",
): Promise<string> {
  // 工作树根目录与 agent 目录同级（默认 ~/.pi/worktrees），而不是其子目录。
  const root = path.join(path.dirname(resolveAgentDir(env)), "worktrees");
  if (create) await mkdir(root, { recursive: true });

  try {
    return await realpath(root);
  } catch {
    throw new WorktreeError(`Pi 工作树根目录不存在：${root}`, missingStage);
  }
}

/** 只读查询使用：仅 ENOENT 表示当前没有 Pi 工作树；其他解析错误必须暴露。 */
export async function resolveExistingWorktreeRoot(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const root = path.join(path.dirname(resolveAgentDir(env)), "worktrees");
  try {
    return await realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new WorktreeError(`无法解析 Pi 工作树根目录：${root}`, "list", root);
  }
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(homedir(), value.slice(2));
  return value;
}

export async function findRegisteredWorktree(
  records: WorktreeRecord[],
  targetPath: string,
): Promise<WorktreeRecord | undefined> {
  for (const record of records) {
    try {
      if (samePath(await realpath(record.path), targetPath)) return record;
    } catch {
      if (samePath(path.resolve(record.path), targetPath)) return record;
    }
  }
  return undefined;
}

export async function runChecked(
  runner: CommandRunner,
  command: string,
  args: string[],
  message: string,
  stage: WorktreeStage,
  worktreePath?: string,
): Promise<CommandResult> {
  const result = await runner.run(command, args);
  if (result.code !== 0) {
    throw new WorktreeError(`${message}（退出码 ${result.code}）`, stage, worktreePath);
  }
  return result;
}

export function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

export function isPathWithinOrEqual(parent: string, candidate: string): boolean {
  return samePath(parent, candidate) || isStrictlyWithin(parent, candidate);
}

export async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw error;
  }
}
