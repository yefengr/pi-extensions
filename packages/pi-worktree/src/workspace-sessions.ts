import { open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { SessionManager, type ExtensionCommandContext, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { samePath } from "./worktree-paths.ts";

export type WorkspaceSession = Pick<SessionInfo, "path" | "id" | "cwd" | "name" | "modified" | "firstMessage">;
const SESSION_HEADER_READ_CHUNK_BYTES = 64 * 1024;

export async function discoverWorkspaceSessions(
  targetCwd: string,
  sessionDir: string,
  parentSession?: string,
): Promise<WorkspaceSession[]> {
  const target = await realpath(targetCwd);
  // 原生切换会重设 sessionDir；迁移 header 中的 parentSession 保留原自定义目录来源。
  const directories = [...new Set([sessionDir, parentSession ? path.dirname(parentSession) : ""].filter(Boolean))];
  const groups = await Promise.all([SessionManager.list(target), ...directories.map((directory) => SessionManager.listAll(directory))]);
  let candidates = await canonicalCandidates(groups.flat(), target);
  if (candidates.length === 0) candidates = await canonicalCandidates(await SessionManager.listAll(), target);
  return candidates.sort((a, b) => b.modified.getTime() - a.modified.getTime() || a.path.localeCompare(b.path));
}

async function canonicalCandidates(sessions: WorkspaceSession[], target: string): Promise<WorkspaceSession[]> {
  const unique = new Map<string, WorkspaceSession>();
  for (const session of sessions) {
    if (!session.cwd || !session.id) continue;
    try {
      if (!samePath(await realpath(session.cwd), target)) continue;
      const file = await realpath(session.path);
      if (![...unique.keys()].some((known) => samePath(known, file))) unique.set(file, { ...session, path: file, cwd: target });
    } catch { /* 原生列表是快照，已移除的路径不再可恢复。 */ }
  }
  return [...unique.values()];
}

export function workspaceSessionLabels(sessions: WorkspaceSession[]): string[] {
  const labels = sessions.map((session) => {
    const summary = (session.name || session.firstMessage || "未命名会话").replace(/\s+/g, " ").trim().slice(0, 100);
    return `${summary} | ${session.modified.toLocaleString()} | ${session.id.slice(0, 8)}`;
  });
  // 名称、时间甚至短 ID 相同也必须能唯一选中。
  return labels.map((label, index) => labels.indexOf(label) === labels.lastIndexOf(label) ? label : `${label} | ${index + 1}`);
}

export async function preflightWorkspaceSession(session: WorkspaceSession, targetCwd: string): Promise<void> {
  const file = await open(session.path, "r");
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size === 0) throw new Error("目标会话必须是非空普通文件");
    const header = await readWorkspaceSessionHeader(file);
    if (header?.type !== "session" || header.id !== session.id || typeof header.cwd !== "string" || !header.cwd) {
      throw new Error("目标会话 header 或 ID 已改变");
    }
    if (!samePath(await realpath(header.cwd), await realpath(targetCwd))) throw new Error("目标会话 cwd 已改变");
  } finally {
    await file.close();
  }
}

async function readWorkspaceSessionHeader(file: FileHandle) {
  const buffer = Buffer.allocUnsafe(SESSION_HEADER_READ_CHUNK_BYTES);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for (;;) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) return JSON.parse(pending + decoder.end() || "null");
    const lines = (pending + decoder.write(buffer.subarray(0, bytesRead))).split(/\r?\n/);
    pending = lines.pop()!;
    for (const line of lines) {
      if (line.trim()) return JSON.parse(line);
    }
  }
}

export class WorkspaceRestoreError extends Error {
  readonly replaced: boolean;

  constructor(message: string, replaced: boolean) {
    super(message);
    this.name = "WorkspaceRestoreError";
    this.replaced = replaced;
  }
}

export async function restoreWorkspaceSession(
  ctx: Pick<ExtensionCommandContext, "switchSession">,
  session: WorkspaceSession,
  targetCwd: string,
): Promise<void> {
  await preflightWorkspaceSession(session, targetCwd);
  let verified = false;
  let replaced = false;
  try {
    const result = await ctx.switchSession(session.path, {
      withSession: async (replacementCtx) => {
        replaced = true;
        try {
          if (!samePath(await realpath(replacementCtx.cwd), targetCwd)) throw new Error("替换会话 cwd 不匹配");
          const file = replacementCtx.sessionManager.getSessionFile();
          if (replacementCtx.sessionManager.getSessionId() !== session.id || !file
            || !samePath(await realpath(file), session.path)) throw new Error("替换会话身份不匹配");
          verified = true;
          replacementCtx.ui.notify(`Pi 会话已恢复到 ${targetCwd}`, "info");
        } catch (error) {
          replacementCtx.ui.notify(`Pi 会话恢复验证失败：${error instanceof Error ? error.message : String(error)}`, "error");
          throw error;
        }
      },
    });
    if (result.cancelled) return;
    if (!verified) throw new WorkspaceRestoreError("Pi 会话切换后未能验证替换会话", true);
  } catch (error) {
    if (error instanceof WorkspaceRestoreError) throw error;
    throw new WorkspaceRestoreError(`Pi 会话恢复失败：${error instanceof Error ? error.message : String(error)}`, replaced);
  }
}
