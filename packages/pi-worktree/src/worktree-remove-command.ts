import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  WorktreeError, inspectRemoveWorktree, listWorktrees, removeWorktree,
  type CommandRunner, type RemoveWorktreeInput, type RemoveWorktreeResult,
} from "./core.ts";
import { formatLocalTime, formatRemoveResult } from "./worktree-format.ts";
import type { WorktreeProgress } from "./worktree-progress.ts";
import type { RemoveWorktreePhase } from "./worktree-remove.ts";
import { selectWorktrees } from "./worktree-select.ts";

interface RemoveCommandOptions {
  runner: CommandRunner;
  progress: WorktreeProgress;
  withMutationLock: <T>(operation: () => Promise<T>) => Promise<T>;
  report: (text: string) => void;
  reportError: (error: unknown) => void;
}

export function formatRemoveProgress(phase: RemoveWorktreePhase, target: string): string {
  const labels: Record<RemoveWorktreePhase, string> = {
    inspect: "正在检查", remove: "正在移除", verify: "正在复核", "branch-remove": "正在删除关联分支",
  };
  return `${labels[phase]} ${target}…`;
}

export async function removeInteractively(
  ctx: ExtensionCommandContext,
  repoPath: string,
  { runner, progress, withMutationLock, report, reportError }: RemoveCommandOptions,
): Promise<void> {
  if (ctx.mode !== "tui") throw new Error("当前模式不能交互收集参数，请向命令传入单个 JSON 对象");
  let completedAny = false;
  for (;;) {
    const candidates = (await progress.run(ctx, "正在加载工作树…", async () => listWorktrees(repoPath, runner))).worktrees;
    if (candidates.length === 0) {
      if (!completedAny) report("指定仓库没有可移除的 Pi 工作树");
      return;
    }
    const selected = await selectWorktrees(ctx, candidates);
    if (!selected?.length) return;
    const scope = selected.some((record) => record.branch)
      ? await ctx.ui.select("移除范围", ["移除工作树和本地分支（默认）", "仅移除工作树（保留本地分支）"])
      : "移除工作树和本地分支（默认）";
    if (!scope) return;
    const keepBranch = scope.startsWith("仅移除");
    const inputs = selected.map((record): RemoveWorktreeInput => ({
      repoPath, worktreePath: record.path, currentCwd: ctx.cwd, confirmed: true, keepBranch,
    }));
    const label = (index: number) => `${index + 1}/${inputs.length}：${path.basename(inputs[index].worktreePath)}`;

    let inspected: Awaited<ReturnType<typeof inspectRemoveWorktree>>[];
    try {
      inspected = await progress.run(ctx, formatRemoveProgress("inspect", label(0)), async (operation) => {
        const results = [];
        for (let index = 0; index < inputs.length; index++) {
          operation.update(formatRemoveProgress("inspect", label(index)));
          results.push(await inspectRemoveWorktree(inputs[index], { runner }));
        }
        return results;
      });
    } catch (error) {
      reportError(error);
      continue;
    }
    const confirmed = await ctx.ui.confirm(
      `确认移除 ${inspected.length} 个工作树`,
      inspected.map((item) => [
        item.worktreePath,
        `分支：${!item.branch ? "无（detached HEAD）" : keepBranch ? `保留 ${item.branch}` : `安全删除 ${item.branch}`}`,
        `创建：${formatLocalTime(item.createdAt)} | 最近提交：${formatLocalTime(item.lastCommitAt)}`,
      ].join("\n")).join("\n\n"),
    );
    if (!confirmed) continue;

    const results: RemoveWorktreeResult[] = [];
    let failure: { error: unknown } | undefined;
    await withMutationLock(() => progress.run(ctx, formatRemoveProgress("inspect", label(0)), async (operation) => {
      for (let index = 0; index < inputs.length; index++) {
        try {
          results.push(await removeWorktree(inputs[index], {
            runner, onProgress: (phase) => operation.update(formatRemoveProgress(phase, label(index))),
          }, inspected[index]));
        } catch (error) {
          failure = { error };
          break;
        }
      }
    }));
    const removalStatus = failure?.error instanceof WorktreeError ? failure.error.removalStatus : "not-started";
    const removedCount = results.length + (removalStatus === "removed" ? 1 : 0);
    completedAny ||= removedCount > 0;
    report([
      `本轮已确认移除 ${removedCount}/${inputs.length} 个工作树`,
      ...results.map(formatRemoveResult),
      ...(removalStatus === "unverified" ? ["另有 1 个工作树移除命令已执行，结果未确认。"] : []),
      ...(failure ? ["批量操作已停止；其余目标未处理。"] : []),
    ].join("\n\n"));
    if (failure) {
      reportError(failure.error);
      return;
    }
  }
}
