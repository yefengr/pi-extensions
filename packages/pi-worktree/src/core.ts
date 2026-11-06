import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isStrictlyWithin } from "./worktree-utils.ts";
import { collectOwnedWorktrees, readOwnershipMarker } from "./worktree-ownership.ts";
import { WORKTREE_MODES, WorktreeError } from "./worktree-types.ts";
import type {
  CommandRunner, CreateWorktreeInput, CreateWorktreeResult, ListWorktreesResult,
  MigrationTarget, WorktreeRecord, WorktreeStage,
} from "./worktree-types.ts";
import {
  type DomainOptions, findRegisteredWorktree, normalizeRequiredString, pathExists,
  readWorktreeRecords, resolveAgentDir, resolveExistingWorktreeRoot, resolveRepository,
  resolveWorktreeRoot, runChecked, samePath,
} from "./worktree-repository.ts";

export { isStrictlyWithin, parseWorktreePorcelain } from "./worktree-utils.ts";
export { OWNERSHIP_MARKER_FILENAME } from "./worktree-ownership.ts";
export type { OwnershipMarker } from "./worktree-ownership.ts";
export { WORKTREE_MODES, WorktreeError } from "./worktree-types.ts";
export type {
  CommandResult, CommandRunner, CreateWorktreeInput, CreateWorktreeResult, ListWorktreesResult,
  MigrationTarget, RemoveWorktreeInput, RemoveWorktreeResult, WorktreeMode, WorktreeRecord, WorktreeStage,
} from "./worktree-types.ts";
export { inspectRemoveWorktree, removeWorktree } from "./worktree-remove.ts";
export type { RemoveWorktreeInspection } from "./worktree-remove.ts";
export { resolveAgentDir, resolveWorktreeRoot } from "./worktree-repository.ts";

const WORKTREE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_WORKTREE_NAME_LENGTH = 40;
const DEFAULT_BASE_REF = "HEAD";
const SETUP_HOOK_PARTS = [".pi", "worktree", "setup.sh"] as const;
const CREATOR_STATE_PREFIX = "pi-worktree-manager-";

export function validateCreateInput(input: CreateWorktreeInput): Required<
  Pick<CreateWorktreeInput, "repoPath" | "name" | "mode">
> & Pick<CreateWorktreeInput, "baseRef" | "branch" | "setupHookApproved"> {
  const repoPath = normalizeRequiredString(input.repoPath, "repoPath");
  const name = normalizeRequiredString(input.name, "name");
  const mode = input.mode;

  if (!WORKTREE_MODES.includes(mode)) {
    throw new WorktreeError(`不支持的工作树模式：${String(mode)}`, "validation");
  }
  if (!WORKTREE_NAME_PATTERN.test(name)) {
    throw new WorktreeError("工作树名称只能包含小写字母、数字和单连字符", "validation");
  }
  if (name.length > MAX_WORKTREE_NAME_LENGTH) {
    throw new WorktreeError(`工作树名称不得超过 ${MAX_WORKTREE_NAME_LENGTH} 个字符`, "validation");
  }

  const baseRef = normalizeOptionalString(input.baseRef);
  const branch = normalizeOptionalString(input.branch);

  if (mode === "new-branch" && (!baseRef || !branch)) {
    throw new WorktreeError("new-branch 模式必须提供 baseRef 和 branch", "validation");
  }
  if (mode === "existing-branch" && (!branch || baseRef)) {
    throw new WorktreeError("existing-branch 模式必须提供 branch，且不能提供 baseRef", "validation");
  }
  if (mode === "detached" && (!baseRef || branch)) {
    throw new WorktreeError("detached 模式必须提供 baseRef，且不能提供 branch", "validation");
  }

  return { repoPath, name, mode, baseRef, branch, setupHookApproved: input.setupHookApproved };
}

export async function inspectCreateRequest(
  input: CreateWorktreeInput,
  options: DomainOptions,
): Promise<{
  input: ReturnType<typeof validateCreateInput>;
  repoPath: string;
  worktreeRoot: string;
  worktreePath: string;
  setupHookPath?: string;
  setupHookResolvedPath?: string;
  setupHookBlobId?: string;
}> {
  const validated = validateCreateInput(input);
  const repository = await resolveRepository(validated.repoPath, options.runner);
  const worktreeRoot = await resolveWorktreeRoot(options.env, true);
  const worktreePath = path.resolve(worktreeRoot, validated.name);

  if (!isStrictlyWithin(worktreeRoot, worktreePath)) {
    throw new WorktreeError("目标工作树路径越过 Pi worktrees 根目录", "validation", worktreePath);
  }
  if (await pathExists(worktreePath)) {
    throw new WorktreeError(`目标路径已经存在：${worktreePath}`, "validation", worktreePath);
  }

  const setupHookPath = path.join(repository.sourceRoot, ...SETUP_HOOK_PARTS);
  if (!(await pathExists(setupHookPath))) {
    return { input: validated, repoPath: repository.sourceRoot, worktreeRoot, worktreePath };
  }

  const hookStat = await lstat(setupHookPath);
  if (!hookStat.isFile() && !hookStat.isSymbolicLink()) {
    throw new WorktreeError(`项目工作树钩子不是普通文件：${setupHookPath}`, "validation", worktreePath);
  }
  let setupHookResolvedPath: string;
  try {
    setupHookResolvedPath = await realpath(setupHookPath);
  } catch {
    throw new WorktreeError(`项目工作树钩子符号链接无法解析：${setupHookPath}`, "validation", worktreePath);
  }
  const setupHookBlobId = (
    await runChecked(
      options.runner, "git", ["hash-object", setupHookPath],
      `无法计算项目工作树钩子内容标识：${setupHookPath}`, "validation", worktreePath,
    )
  ).stdout.trim();
  if (!setupHookBlobId) {
    throw new WorktreeError("项目工作树钩子内容标识为空", "validation", worktreePath);
  }

  return {
    input: validated, repoPath: repository.sourceRoot, worktreeRoot, worktreePath,
    setupHookPath, setupHookResolvedPath, setupHookBlobId,
  };
}

export async function createWorktree(
  input: CreateWorktreeInput,
  options: DomainOptions,
): Promise<CreateWorktreeResult> {
  const inspected = await inspectCreateRequest(input, options);
  if (inspected.setupHookPath && inspected.input.setupHookApproved !== true) {
    throw new WorktreeError(
      `项目存在工作树钩子，执行前必须明确批准：${inspected.setupHookPath}`,
      "hook-approval", inspected.worktreePath,
    );
  }

  const stateDir = await mkdtemp(path.join(tmpdir(), CREATOR_STATE_PREFIX));
  const stateFile = path.join(stateDir, "state");
  const args = buildCreatorArgs(inspected, stateFile);

  try {
    const result = await options.runner.run("env", [
      `PI_CODING_AGENT_DIR=${resolveAgentDir(options.env)}`,
      "bash", options.creatorPath, ...args,
    ]);
    const state = await readCreatorState(stateFile);
    if (result.code !== 0) {
      throw creatorFailure(state, inspected.worktreePath, result.code);
    }
    if (state !== "completed") {
      throw new WorktreeError(
        "创建器未返回完成状态，工作树状态需要人工核对", "verification", inspected.worktreePath,
      );
    }

    const records = await readWorktreeRecords(inspected.repoPath, options.runner);
    const record = await findRegisteredWorktree(records, inspected.worktreePath);
    if (!record) {
      throw new WorktreeError(
        "创建器已退出，但 Git 未登记目标工作树", "verification", inspected.worktreePath,
      );
    }
    verifyCreatedRecord(record, inspected.input);
    if (!(await readOwnershipMarker(inspected.worktreePath, options.runner))) {
      throw new WorktreeError(
        "创建器已退出，但目标工作树缺少有效的 Pi 所有权标记", "verification", inspected.worktreePath,
      );
    }

    return {
      repoPath: inspected.repoPath,
      worktreePath: inspected.worktreePath,
      mode: inspected.input.mode,
      baseRef: inspected.input.baseRef ?? inspected.input.branch ?? DEFAULT_BASE_REF,
      branch: record.branch,
      head: record.head,
      setupHook: inspected.setupHookPath
        ? {
            status: "completed", path: inspected.setupHookPath,
            resolvedPath: inspected.setupHookResolvedPath, blobId: inspected.setupHookBlobId,
          }
        : { status: "skipped" },
    };
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

export async function listWorktrees(
  repoPath: string,
  runner: CommandRunner,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ListWorktreesResult> {
  const repository = await resolveRepository(repoPath, runner);
  const worktreeRoot = await resolveExistingWorktreeRoot(env);
  if (!worktreeRoot) return { repoPath: repository.sourceRoot, worktrees: [] };

  const worktrees = await collectOwnedWorktrees(
    repository.records, repository.sourceRoot, worktreeRoot, runner,
  );
  return { repoPath: repository.sourceRoot, worktrees };
}

export async function resolveMigrationTarget(
  repoPath: string,
  worktreePath: string,
  options: Pick<DomainOptions, "runner" | "env"> & { allowMainWorktree?: boolean },
): Promise<MigrationTarget> {
  const repository = await resolveRepository(repoPath, options.runner);
  const requestedPath = normalizeRequiredString(worktreePath, "worktreePath");
  if (!path.isAbsolute(requestedPath)) {
    throw new WorktreeError("worktreePath 必须是绝对路径", "migration");
  }

  let targetPath: string;
  try {
    targetPath = await realpath(requestedPath);
  } catch {
    throw new WorktreeError(`工作树路径不存在：${requestedPath}`, "migration", requestedPath);
  }
  if (samePath(targetPath, repository.sourceRoot)) {
    const record = await findRegisteredWorktree(repository.records, targetPath);
    if (options.allowMainWorktree === true && record && !record.bare) {
      return { repoPath: repository.sourceRoot, worktreePath: targetPath, record };
    }
    throw new WorktreeError("不能把会话迁移到仓库主工作区", "migration", targetPath);
  }
  const worktreeRoot = await resolveWorktreeRoot(options.env, false, "migration");
  if (!isStrictlyWithin(worktreeRoot, targetPath)) {
    throw new WorktreeError("只能迁移到 Pi worktrees 根目录内的工作树", "migration", targetPath);
  }

  const record = await findRegisteredWorktree(repository.records, targetPath);
  if (!record || record.bare) {
    throw new WorktreeError("目标路径未由指定仓库登记为 linked worktree", "migration", targetPath);
  }
  if (!(await readOwnershipMarker(targetPath, options.runner))) {
    throw new WorktreeError("目标路径缺少有效的 Pi 工作树所有权标记", "migration", targetPath);
  }

  return { repoPath: repository.sourceRoot, worktreePath: targetPath, record };
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new WorktreeError("可选引用或分支参数必须是字符串", "validation");
  const normalized = value.trim();
  return normalized || undefined;
}

function buildCreatorArgs(
  inspected: Awaited<ReturnType<typeof inspectCreateRequest>>,
  stateFile: string,
): string[] {
  const args = ["--repo", inspected.repoPath, "--name", inspected.input.name, "--state-file", stateFile];

  if (inspected.setupHookPath) {
    args.push("--approve-setup-hook", inspected.setupHookBlobId!);
  }
  if (inspected.input.mode === "new-branch") {
    args.push("--base", inspected.input.baseRef!, "--branch", inspected.input.branch!);
  } else if (inspected.input.mode === "existing-branch") {
    args.push("--existing-branch", inspected.input.branch!);
  } else {
    args.push("--base", inspected.input.baseRef!, "--detach");
  }
  return args;
}

async function readCreatorState(stateFile: string): Promise<string> {
  try {
    return (await readFile(stateFile, "utf8")).trim();
  } catch {
    return "unknown";
  }
}

const CREATOR_FAILURE_STAGES: Record<string, WorktreeStage> = {
  "before-create": "before-create", "git-add": "git-add", ownership: "ownership", "after-create": "after-create",
};

function creatorFailure(state: string, worktreePath: string, code: number): WorktreeError {
  const stage = CREATOR_FAILURE_STAGES[state] ?? "validation";
  const retained = stage === "after-create" || stage === "ownership"
    ? `；已保留工作树供诊断：${worktreePath}` : "";
  return new WorktreeError(
    `工作树创建在 ${stage} 阶段失败（退出码 ${code}）${retained}。钩子输出未回显，以避免泄露敏感信息`,
    stage, worktreePath,
  );
}

function verifyCreatedRecord(record: WorktreeRecord, input: ReturnType<typeof validateCreateInput>): void {
  if (input.mode === "detached" && !record.detached) {
    throw new WorktreeError("目标工作树不是预期的 detached HEAD", "verification", record.path);
  }
  if (input.mode !== "detached" && record.branch !== input.branch) {
    throw new WorktreeError(
      `目标工作树分支不符合预期：${record.branch ?? "detached"}`, "verification", record.path,
    );
  }
}
