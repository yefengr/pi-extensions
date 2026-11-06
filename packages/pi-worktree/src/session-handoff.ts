import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface HandoffRequest {
  sourceSessionFile: string;
  repoPath: string;
  worktreePath: string;
  phase: "scheduled" | "dispatched";
}

type SourceContext = Pick<ExtensionContext, "sessionManager">;

/** 请求只活在创建它的运行时；失败、取消或会话关闭后不重放。 */
export function createSessionHandoff(pi: ExtensionAPI) {
  let pending: HandoffRequest | undefined;
  let closed = false;
  const clear = () => { pending = undefined; };
  const assertAvailable = () => {
    if (closed) throw new Error("来源会话已关闭，不能继续安排工作空间切换");
    if (pending) throw new Error("工作空间自动切换待完成，请等待切换后再创建工作树");
  };

  pi.on("tool_call", () => {
    if (pending) return { block: true, terminate: true, reason: "工作空间自动切换待完成，禁止继续在旧目录执行工具；请结束本轮并等待切换。" };
  });
  pi.on("session_shutdown", () => { closed = true; clear(); });
  pi.on("agent_settled", (event, ctx) => {
    if (!pending) return;
    const stopped = event.aborted ? "自动切换已取消" :
      pending.sourceSessionFile !== ctx.sessionManager.getSessionFile() ? "自动切换来源会话发生变化" :
      pending.phase === "dispatched" ? "未完成自动切换：派发的命令未被消费" : undefined;
    if (stopped) {
      const { repoPath, worktreePath } = pending;
      clear();
      ctx.ui.notify(`${stopped}；目标：${worktreePath}\n手动恢复：${formatMigrationCommand(repoPath, worktreePath)}`, "warning");
      return;
    }
    pending.phase = "dispatched";
    const { repoPath, worktreePath } = pending;
    try {
      // 不用 deliverAs；否则 slash command 会成为普通模型输入。
      pi.sendUserMessage(formatMigrationCommand(repoPath, worktreePath, true), { expandPromptTemplates: true });
    } catch (error) {
      clear();
      ctx.ui.notify(`自动切换命令派发失败：${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  return {
    assertAvailable,
    clear,
    schedule(sourceSessionFile: string | undefined, repoPath: string, worktreePath: string): boolean {
      assertAvailable();
      if (!sourceSessionFile) return false;
      pending = { sourceSessionFile, repoPath, worktreePath, phase: "scheduled" };
      return true;
    },
    claim(ctx: SourceContext, repoPath: string, worktreePath: string): void {
      const request = pending;
      clear();
      if (request?.phase !== "dispatched" ||
          request.sourceSessionFile !== ctx.sessionManager.getSessionFile() ||
          request.repoPath !== repoPath || request.worktreePath !== worktreePath) {
        throw new Error("自动切换请求已过期或不属于当前会话；可使用 /worktree:migrate 手动恢复");
      }
    },
  };
}

export function formatMigrationCommand(repoPath: string, worktreePath: string, continueTask = false): string {
  return `/worktree:migrate ${JSON.stringify({ repoPath, worktreePath, ...(continueTask ? { continueTask: true } : {}) })}`;
}

export function parseContinueTask(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error("continueTask 必须是布尔值");
  return value;
}
