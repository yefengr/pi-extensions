import path from "node:path";
import { realpath } from "node:fs/promises";
import { samePath } from "./worktree-paths.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { listWorktrees, resolveMigrationTarget, type CommandRunner } from "./core.ts";
import { migratePersistentSession, type SessionForker } from "./session.ts";
import { createWorktreeProgress, type WorktreeProgress } from "./worktree-progress.ts";

export interface WorkspaceChoice {
  path: string;
  label: string;
  current: boolean;
}

export async function collectWorkspaceChoices(cwd: string, runner: CommandRunner): Promise<WorkspaceChoice[]> {
  const listed = await listWorktrees(cwd, runner);
  const main = await resolveMigrationTarget(listed.repoPath, listed.repoPath, { runner, allowMainWorktree: true });
  const topLevel = await runner.run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (topLevel.code !== 0) throw new Error(`无法识别当前 Git 工作区：${topLevel.stderr.trim()}`);
  const currentRoot = await realpath(topLevel.stdout.trim());
  return Promise.all([
    { ...main.record, path: main.worktreePath, main: true },
    ...listed.worktrees.map((record) => ({ ...record, main: false })),
  ].map(async (record) => {
    const canonicalPath = await realpath(record.path);
    const current = samePath(currentRoot, canonicalPath);
    return {
      path: canonicalPath,
      current,
      label: `${current ? "[当前] " : ""}${record.main ? "主工作区" : path.basename(canonicalPath)} | ${record.branch ?? "detached HEAD"} | ${canonicalPath}`,
    };
  }));
}

export function registerWorktreeSwitch(
  pi: ExtensionAPI,
  runner: CommandRunner,
  forker: SessionForker,
  withMutationLock: <T>(operation: () => Promise<T>) => Promise<T>,
  reportError: (error: unknown) => void,
  progress: WorktreeProgress = createWorktreeProgress(pi),
): void {
  pi.registerCommand("worktree:switch", {
    description: "通过列表切换到当前仓库的主工作区或 Pi 管理工作树",
    handler: async (args, ctx) => {
      try {
        if (!ctx.isIdle()) {
          ctx.ui.notify("代理正在运行，请在本轮结束后切换工作空间", "warning");
          return;
        }
        const parsed = parseSwitchInput(args);
        if (!parsed && ctx.mode !== "tui") throw new Error("当前模式不能显示选择列表，请向 /worktree:switch 传入 JSON worktreePath");
        const choices = await progress.run(ctx, "正在加载工作树…", async () => {
          const loaded = await collectWorkspaceChoices(ctx.cwd, runner);
          if (parsed?.repoPath !== undefined) {
            const requested = await listWorktrees(parsed.repoPath, runner);
            if (!samePath(requested.repoPath, loaded[0].path)) throw new Error("只能切换当前仓库的工作空间");
          }
          return loaded;
        });
        const selectedPath = parsed?.worktreePath ?? await selectWorkspace(ctx, choices);
        if (!selectedPath) return;
        await progress.run(ctx, "正在检查切换目标…", async (operation) => {
          const target = await resolveMigrationTarget(choices[0].path, selectedPath, { runner, allowMainWorktree: true });
          if (samePath(await realpath(ctx.cwd), target.worktreePath)) return;
          operation.update(`正在切换到 ${path.basename(target.worktreePath)}…`);
          await ctx.waitForIdle();
          await withMutationLock(async () => {
            const migration = await migratePersistentSession(
              ctx, target.worktreePath,
              forker,
              `Pi 会话已切换到 ${target.worktreePath}\n分支：${target.record.branch ?? "detached HEAD"}`,
            );
            if (migration.status === "unavailable") ctx.ui.notify("当前会话未持久化，无法切换工作空间；原会话保持不变", "warning");
          });
        });
      } catch (error) {
        reportError(error);
      }
    },
  });
  pi.registerShortcut("ctrl+alt+w", {
    description: "选择并切换工作空间",
    handler(ctx) {
      if (!ctx.isIdle()) {
        ctx.ui.notify("代理正在运行，请在本轮结束后切换工作空间", "warning");
        return;
      }
      pi.sendUserMessage("/worktree:switch", { expandPromptTemplates: true });
    },
  });
}

async function selectWorkspace(ctx: ExtensionCommandContext, choices: WorkspaceChoice[]): Promise<string | undefined> {
  const selected = await ctx.ui.select("选择工作空间", choices.map((choice) => choice.label));
  return choices.find((choice) => choice.label === selected)?.path;
}

function parseSwitchInput(args: string): { repoPath?: string; worktreePath: string } | undefined {
  if (!args.trim()) return undefined;
  let input: unknown;
  try { input = JSON.parse(args); } catch { throw new Error("命令参数必须是单个 JSON 对象；TUI 下可直接使用选择列表"); }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("命令参数必须是 JSON 对象");
  const parsed = input as Record<string, unknown>;
  if (Object.keys(parsed).some((key) => key !== "repoPath" && key !== "worktreePath")) throw new Error("/worktree:switch 仅接受 repoPath 和 worktreePath");
  if (typeof parsed.worktreePath !== "string" || !parsed.worktreePath.trim()) throw new Error("worktreePath 必须是非空字符串");
  if (parsed.repoPath !== undefined && (typeof parsed.repoPath !== "string" || !parsed.repoPath.trim())) throw new Error("repoPath 必须是非空字符串");
  return { repoPath: (parsed.repoPath as string | undefined)?.trim(), worktreePath: parsed.worktreePath.trim() };
}
