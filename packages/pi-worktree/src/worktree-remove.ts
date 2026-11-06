import { realpath } from "node:fs/promises";
import path from "node:path";
import { readLastCommitAt, readOwnershipMarker } from "./worktree-ownership.ts";
import { WorktreeError } from "./worktree-types.ts";
import type { CommandResult, CommandRunner, RemoveWorktreeInput, RemoveWorktreeResult, WorktreeRecord } from "./worktree-types.ts";
import { isStrictlyWithin } from "./worktree-utils.ts";
import {
  type DomainOptions, findRegisteredWorktree, isPathWithinOrEqual, normalizeRequiredString,
  readWorktreeRecords, resolveRepository, resolveWorktreeRoot, runChecked, samePath,
} from "./worktree-repository.ts";

export type RemoveWorktreePhase = "inspect" | "remove" | "verify" | "branch-remove";

type RemoveWorktreeOptions = Pick<DomainOptions, "runner" | "env"> & {
  onProgress?: (phase: RemoveWorktreePhase) => void;
};

function reportProgress(options: RemoveWorktreeOptions, phase: RemoveWorktreePhase): void {
  try { options.onProgress?.(phase); } catch { /* 反馈失败不得跳过安全检查或改变删除结果。 */ }
}

export interface RemoveWorktreeInspection extends Pick<
  RemoveWorktreeResult,
  "repoPath" | "worktreePath" | "branch" | "createdAt" | "lastCommitAt"
> {
  head?: string;
}

export async function inspectRemoveWorktree(
  input: Omit<RemoveWorktreeInput, "confirmed">,
  options: RemoveWorktreeOptions,
): Promise<RemoveWorktreeInspection> {
  reportProgress(options, "inspect");
  const repository = await resolveRepository(input.repoPath, options.runner);
  const worktreeRoot = await resolveWorktreeRoot(options.env, false, "remove");
  const requestedPath = normalizeRequiredString(input.worktreePath, "worktreePath");
  if (!path.isAbsolute(requestedPath)) {
    throw new WorktreeError("worktreePath 必须是绝对路径", "remove");
  }

  let targetPath: string;
  try {
    targetPath = await realpath(requestedPath);
  } catch {
    throw new WorktreeError(`工作树路径不存在：${requestedPath}`, "remove", requestedPath);
  }
  if (!isStrictlyWithin(worktreeRoot, targetPath)) {
    throw new WorktreeError("只能移除 Pi worktrees 根目录内的工作树", "remove", targetPath);
  }
  if (samePath(targetPath, repository.sourceRoot)) {
    throw new WorktreeError("不能移除仓库主工作区", "remove", targetPath);
  }

  const currentCwd = await realpath(normalizeRequiredString(input.currentCwd, "currentCwd"));
  if (isPathWithinOrEqual(targetPath, currentCwd)) {
    throw new WorktreeError("不能移除当前 Pi 会话所在工作树", "remove", targetPath);
  }

  const record = await findRegisteredWorktree(repository.records, targetPath);
  if (!record) {
    throw new WorktreeError("目标路径未由指定仓库登记为工作树", "remove", targetPath);
  }
  if (record.locked) {
    throw new WorktreeError("目标工作树处于 locked 状态，拒绝移除", "remove", targetPath);
  }
  const marker = await readOwnershipMarker(targetPath, options.runner);
  if (!marker) {
    throw new WorktreeError("目标路径缺少有效的 Pi 工作树所有权标记", "remove", targetPath);
  }
  const lastCommitAt = await readLastCommitAt(targetPath, record.head, options.runner);

  const status = await runChecked(
    options.runner,
    "git",
    ["-C", targetPath, "status", "--porcelain=v1", "--untracked-files=normal"],
    "无法检查目标工作树状态",
    "remove",
    targetPath,
  );
  if (status.stdout.trim()) {
    throw new WorktreeError("目标工作树存在未提交变更，拒绝移除", "remove", targetPath);
  }

  if (record.branch && !input.keepBranch) {
    await verifyBranchCanBeDeleted(repository.sourceRoot, record.branch, targetPath, options.runner);
  }

  return {
    repoPath: repository.sourceRoot,
    worktreePath: targetPath,
    branch: record.branch,
    head: record.head,
    createdAt: marker.createdAt,
    lastCommitAt,
  };
}

export async function removeWorktree(
  input: RemoveWorktreeInput,
  options: RemoveWorktreeOptions,
  expected?: RemoveWorktreeInspection,
): Promise<RemoveWorktreeResult> {
  if (input.confirmed !== true) {
    throw new WorktreeError("移除工作树必须显式确认 confirmed=true", "remove");
  }

  const inspected = await inspectRemoveWorktree(input, options);
  const { repoPath, worktreePath: targetPath, branch } = inspected;
  if (expected && (
    inspected.repoPath !== expected.repoPath || inspected.worktreePath !== expected.worktreePath ||
    inspected.createdAt !== expected.createdAt || inspected.branch !== expected.branch ||
    inspected.head !== expected.head
  )) {
    throw new WorktreeError("目标工作树或分支在确认后发生变化；工作树和分支均未移除，请重新确认", "remove", targetPath);
  }
  reportProgress(options, "remove");
  await runChecked(
    options.runner,
    "git",
    ["-C", repoPath, "worktree", "remove", targetPath],
    "Git 拒绝移除目标工作树；未使用 --force",
    "remove",
    targetPath,
  );

  reportProgress(options, "verify");
  let remaining: WorktreeRecord[];
  try {
    remaining = await readWorktreeRecords(repoPath, options.runner);
  } catch {
    throw new WorktreeError(
      "Git 工作树移除命令已成功，但无法复核登记状态；关联分支未处理，请核对工作树与分支",
      "verification",
      targetPath,
      "unverified",
    );
  }
  if (await findRegisteredWorktree(remaining, targetPath)) {
    throw new WorktreeError(
      "Git 工作树移除命令已执行，但仍登记目标工作树；关联分支未处理，请核对工作树与分支",
      "verification",
      targetPath,
      "unverified",
    );
  }

  if (branch && !input.keepBranch) {
    reportProgress(options, "branch-remove");
    await deleteAssociatedBranch(repoPath, branch, targetPath, options.runner);
  }

  return {
    repoPath: inspected.repoPath,
    worktreePath: inspected.worktreePath,
    branch: inspected.branch,
    createdAt: inspected.createdAt,
    lastCommitAt: inspected.lastCommitAt,
    branchStatus: !branch ? "not-applicable" : input.keepBranch ? "preserved" : "deleted",
  };
}

async function verifyBranchCanBeDeleted(
  repoPath: string,
  branch: string,
  worktreePath: string,
  runner: CommandRunner,
): Promise<void> {
  const ref = `refs/heads/${branch}`;
  const upstream = await runChecked(
    runner,
    "git",
    ["-C", repoPath, "for-each-ref", "--format=%(refname) %(upstream)", ref],
    "无法检查关联分支的上游",
    "remove",
    worktreePath,
  );
  const entry = upstream.stdout.split("\n").find((line) => line.startsWith(`${ref} `));
  if (!entry) {
    throw new WorktreeError("关联分支已不存在；工作树未移除", "remove", worktreePath);
  }
  const upstreamRef = entry.slice(ref.length + 1).trim();
  for (const target of ["HEAD", ...(upstreamRef ? [upstreamRef] : [])]) {
    const merged = await runner.run("git", ["-C", repoPath, "merge-base", "--is-ancestor", ref, target]);
    if (merged.code === 1) {
      throw new WorktreeError(`关联分支尚未合并到 ${target}；工作树和分支均未移除`, "remove", worktreePath);
    }
    if (merged.code !== 0) {
      throw new WorktreeError(`无法确认关联分支是否已合并到 ${target}；工作树和分支均未移除`, "remove", worktreePath);
    }
  }
}

async function deleteAssociatedBranch(
  repoPath: string,
  branch: string,
  worktreePath: string,
  runner: CommandRunner,
): Promise<void> {
  let deleted: CommandResult;
  try {
    deleted = await runner.run("git", ["-C", repoPath, "branch", "-d", "--", branch]);
  } catch {
    throw new WorktreeError(
      `工作树已移除，但删除关联分支 ${branch} 时命令异常；分支状态未确认，请人工核对`,
      "branch-remove",
      worktreePath,
      "removed",
    );
  }
  if (deleted.code !== 0) {
    const branchState = await describeBranchState(repoPath, branch, runner);
    throw new WorktreeError(
      `工作树已移除，但关联分支 ${branch} 删除失败（退出码 ${deleted.code}）；${branchState}`,
      "branch-remove",
      worktreePath,
      "removed",
    );
  }
}

async function describeBranchState(repoPath: string, branch: string, runner: CommandRunner): Promise<string> {
  try {
    const result = await runner.run("git", [
      "-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`,
    ]);
    if (result.code === 0) return "分支仍保留，需人工处理";
    if (result.code === 1) return "当前未找到分支，需人工核对";
  } catch {
    // 删除分支命令已失败，此处仅尽力确认实际状态。
  }
  return "分支状态未确认，需人工核对";
}
