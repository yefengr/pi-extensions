export const WORKTREE_MODES = ["new-branch", "existing-branch", "detached"] as const;
export type WorktreeMode = (typeof WORKTREE_MODES)[number];

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface CommandRunner {
  run(
    command: string,
    args: string[],
    options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
  ): Promise<CommandResult>;
}

export interface WorktreeRecord {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked?: string | true;
  prunable?: string | true;
  /** 来自 Pi 所有权标记的 ISO 8601 创建时间，仅存在于 Pi 管理的工作树记录。 */
  createdAt?: string;
  /** 该工作树 HEAD 所指提交的提交时间，不包含未提交文件的修改。 */
  lastCommitAt?: string;
}

export interface CreateWorktreeInput {
  repoPath: string;
  name: string;
  mode: WorktreeMode;
  baseRef?: string;
  branch?: string;
  setupHookApproved?: boolean;
}

export interface CreateWorktreeResult {
  repoPath: string;
  worktreePath: string;
  mode: WorktreeMode;
  baseRef: string;
  branch?: string;
  head?: string;
  setupHook: {
    status: "skipped" | "completed";
    path?: string;
    resolvedPath?: string;
    blobId?: string;
  };
}

export interface ListWorktreesResult {
  repoPath: string;
  worktrees: WorktreeRecord[];
}

export interface MigrationTarget {
  repoPath: string;
  worktreePath: string;
  record: WorktreeRecord;
}

export interface RemoveWorktreeInput {
  repoPath: string;
  worktreePath: string;
  currentCwd: string;
  confirmed: boolean;
  /** 仅移除工作树；默认同时安全删除关联本地分支。 */
  keepBranch?: boolean;
}

export interface RemoveWorktreeResult {
  repoPath: string;
  worktreePath: string;
  branch?: string;
  createdAt: string;
  lastCommitAt?: string;
  branchStatus: "deleted" | "preserved" | "not-applicable";
}

export type WorktreeStage =
  | "validation"
  | "repository"
  | "hook-approval"
  | "before-create"
  | "git-add"
  | "ownership"
  | "after-create"
  | "verification"
  | "list"
  | "migration"
  | "remove"
  | "branch-remove";

export type WorktreeRemovalStatus = "not-started" | "unverified" | "removed";

export class WorktreeError extends Error {
  readonly stage: WorktreeStage;
  readonly worktreePath?: string;
  readonly removalStatus: WorktreeRemovalStatus;

  constructor(
    message: string,
    stage: WorktreeStage,
    worktreePath?: string,
    removalStatus: WorktreeRemovalStatus = "not-started",
  ) {
    super(message);
    this.name = "WorktreeError";
    this.stage = stage;
    this.worktreePath = worktreePath;
    this.removalStatus = removalStatus;
  }
}
