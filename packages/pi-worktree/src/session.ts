import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { samePath } from "./worktree-paths.ts";

export interface SessionMigrationResult {
  status: "migrated" | "unavailable";
  sourceSessionFile?: string;
  migratedSessionFile?: string;
  targetCwd: string;
}

export class SessionMigrationError extends Error {
  readonly targetCwd: string;
  readonly migratedSessionFile?: string;

  constructor(message: string, targetCwd: string, migratedSessionFile?: string) {
    super(message);
    this.name = "SessionMigrationError";
    this.targetCwd = targetCwd;
    this.migratedSessionFile = migratedSessionFile;
  }
}

export interface SessionForker {
  forkFrom(sourcePath: string, targetCwd: string): {
    getSessionFile(): string | undefined;
  };
}

export async function migratePersistentSession(
  ctx: Pick<ExtensionCommandContext, "cwd" | "sessionManager" | "switchSession">,
  targetCwd: string,
  forker: SessionForker,
  successMessage = `Pi 会话已迁移到 ${targetCwd}`,
  continueTask = false,
): Promise<SessionMigrationResult> {
  const normalizedTarget = await realpath(targetCwd);
  const sourceSessionFile = ctx.sessionManager.getSessionFile();
  if (!sourceSessionFile) {
    return { status: "unavailable", targetCwd: normalizedTarget };
  }

  let migratedSessionFile: string | undefined;
  try {
    const migrated = forker.forkFrom(sourceSessionFile, normalizedTarget);
    migratedSessionFile = migrated.getSessionFile();
    if (!migratedSessionFile) {
      throw new Error("迁移后的 Pi 会话文件不可用");
    }

    let replacementVerified = false;
    const switchResult = await ctx.switchSession(migratedSessionFile, {
      withSession: async (replacementCtx) => {
        try {
          await verifyReplacementContext(replacementCtx, normalizedTarget);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          replacementCtx.ui.notify(`Pi 会话迁移验证失败：${message}`, "error");
          throw new SessionMigrationError(`Pi 会话迁移验证失败：${message}`, normalizedTarget, migratedSessionFile);
        }
        replacementVerified = true;
        replacementCtx.ui.notify(successMessage, "info");
        if (continueTask) {
          try {
            await replacementCtx.sendMessage({
              customType: "worktree:message",
              content: `工作树创建与初始化已完成，会话已切换到 ${normalizedTarget}。请在当前真实工作目录继续原任务；不要重复创建工作树。`,
              display: true,
              details: { worktreePath: normalizedTarget, continueTask: true },
            }, { triggerTurn: true });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            replacementCtx.ui.notify(`会话已切换，但自动继续任务失败：${message}`, "error");
          }
        }
      },
    });

    if (switchResult.cancelled) {
      throw new SessionMigrationError(
        "Pi 会话切换被取消",
        normalizedTarget,
        migratedSessionFile,
      );
    }
    if (!replacementVerified) {
      throw new SessionMigrationError(
        "Pi 会话切换后未能验证替换会话的 cwd",
        normalizedTarget,
        migratedSessionFile,
      );
    }

    return {
      status: "migrated",
      sourceSessionFile,
      migratedSessionFile,
      targetCwd: normalizedTarget,
    };
  } catch (error) {
    if (error instanceof SessionMigrationError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new SessionMigrationError(
      `Pi 会话迁移失败：${message}`,
      normalizedTarget,
      migratedSessionFile,
    );
  }
}

async function verifyReplacementContext(
  ctx: Pick<ExtensionCommandContext, "cwd">,
  expectedCwd: string,
): Promise<void> {
  const replacementCwd = await realpath(ctx.cwd);
  if (!samePath(replacementCwd, expectedCwd)) {
    throw new Error(`替换会话 cwd 不匹配：${replacementCwd}`);
  }
}
