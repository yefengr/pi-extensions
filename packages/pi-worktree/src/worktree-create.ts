import { writeFile } from "node:fs/promises";
import path from "node:path";
import { OWNERSHIP_MARKER_FILENAME } from "./worktree-ownership.ts";
import type { DomainOptions } from "./worktree-repository.ts";
import { pathExists, resolveAgentDir, runChecked } from "./worktree-repository.ts";
import { samePath } from "./worktree-paths.ts";
import { runPosixHook, verifySetupHook, type SetupHook } from "./worktree-hook.ts";
import { WorktreeError, type CreateWorktreeInput, type WorktreeStage } from "./worktree-types.ts";

interface CreatePlan extends SetupHook {
  input: CreateWorktreeInput;
  repoPath: string;
  worktreePath: string;
}

export async function validateCreateRefs(plan: CreatePlan, options: DomainOptions): Promise<void> {
  const { input, repoPath, worktreePath } = plan;
  const check = async (args: string[], message: string) =>
    runChecked(options.runner, "git", ["-C", repoPath, ...args], message, "validation", worktreePath);
  if (input.mode !== "detached") {
    await check(["check-ref-format", "--branch", input.branch!], `分支名称不合法：${input.branch}`);
    const exists = await options.runner.run("git", ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`]);
    if (exists.code !== 0 && exists.code !== 1) {
      throw new WorktreeError("无法检查本地分支", "validation", worktreePath);
    }
    if (input.mode === "existing-branch" && exists.code !== 0) {
      throw new WorktreeError(`本地分支不存在：${input.branch}`, "validation", worktreePath);
    }
    if (input.mode === "new-branch" && exists.code === 0) {
      throw new WorktreeError(`本地分支已经存在，请改用 existing-branch：${input.branch}`, "validation", worktreePath);
    }
  }
  if (input.mode !== "existing-branch") {
    await check(["rev-parse", "--verify", "--quiet", "--end-of-options", `${input.baseRef}^{commit}`],
      `基准引用无法解析为提交：${input.baseRef}`);
  }
}

export async function executeCreatePlan(plan: CreatePlan, options: DomainOptions): Promise<void> {
  await validateCreateRefs(plan, options);
  if (plan.setupHookPath) await executeHook(plan, options, "before-create", plan.repoPath);
  options.signal?.throwIfAborted();
  if (await pathExists(plan.worktreePath)) {
    throw new WorktreeError(`目标路径已经存在：${plan.worktreePath}`, "git-add", plan.worktreePath);
  }
  const { input } = plan;
  const args = input.mode === "new-branch"
    ? ["-b", input.branch!, plan.worktreePath, input.baseRef!]
    : input.mode === "existing-branch"
      ? [plan.worktreePath, input.branch!]
      : ["--detach", plan.worktreePath, input.baseRef!];
  await runChecked(options.runner, "git", ["-C", plan.repoPath, "worktree", "add", ...args],
    "Git 无法创建工作树", "git-add", plan.worktreePath);
  try {
    await writeOwnership(plan, options);
  } catch (error) {
    if (isAbort(error)) throw error;
    throw stageFailure("ownership", plan.worktreePath);
  }
  if (plan.setupHookPath) await executeHook(plan, options, "after-create", plan.worktreePath);
}

async function writeOwnership(plan: CreatePlan, options: DomainOptions): Promise<void> {
  const query = async (args: string[]) => (await runChecked(options.runner, "git",
    ["-C", plan.worktreePath, "rev-parse", ...args], "无法读取目标 Git 管理目录", "ownership", plan.worktreePath)).stdout.trim();
  const gitDir = await query(["--absolute-git-dir"]);
  const commonDir = await query(["--path-format=absolute", "--git-common-dir"]);
  if (!path.isAbsolute(gitDir) || !path.isAbsolute(commonDir) || samePath(gitDir, commonDir)) {
    throw new Error("目标不是 linked worktree 管理目录");
  }
  await writeFile(path.join(gitDir, OWNERSHIP_MARKER_FILENAME),
    `${JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString() })}\n`, { encoding: "utf8", flag: "wx" });
}

async function executeHook(
  plan: CreatePlan, options: DomainOptions, phase: "before-create" | "after-create", cwd: string,
): Promise<void> {
  try {
    await verifySetupHook(plan, options.runner);
    await (options.hookRunner ?? runPosixHook)(plan.setupHookPath!, phase, {
      cwd, signal: options.signal,
      env: {
        ...process.env, ...options.env,
        PI_CODING_AGENT_DIR: resolveAgentDir(options.env),
        PI_WORKTREE_PHASE: phase, PI_WORKTREE_SOURCE_ROOT: plan.repoPath,
        PI_WORKTREE_TARGET: plan.worktreePath, PI_WORKTREE_BASE: plan.input.baseRef ?? plan.input.branch!,
        PI_WORKTREE_BRANCH: plan.input.branch ?? "", PI_WORKTREE_NAME: plan.input.name,
        PI_WORKTREE_MODE: plan.input.mode,
      },
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw stageFailure(phase, plan.worktreePath);
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function stageFailure(stage: WorktreeStage, target: string): WorktreeError {
  const retained = stage === "after-create" || stage === "ownership" ? `；已保留工作树供诊断：${target}` : "";
  return new WorktreeError(`工作树创建在 ${stage} 阶段失败${retained}。钩子输出未回显，以避免泄露敏感信息`, stage, target);
}
