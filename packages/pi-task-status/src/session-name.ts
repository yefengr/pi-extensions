import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanText, normalizeStatusInput } from "./status.ts";

export const SESSION_NAME_OWNER_TYPE = "task-status-session-name";

interface SessionNameOwner {
  version: 1;
  sessionInfoId: string;
  name: string;
}

export interface SessionNameEntryLike {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  customType?: unknown;
  data?: unknown;
}

function parseOwner(value: unknown): SessionNameOwner | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).length !== 3 ||
    fields.version !== 1 ||
    typeof fields.sessionInfoId !== "string" ||
    !fields.sessionInfoId ||
    cleanText(fields.sessionInfoId) !== fields.sessionInfoId ||
    typeof fields.name !== "string"
  ) return undefined;
  try {
    const normalized = normalizeStatusInput({
      taskTransition: "continue",
      taskName: fields.name,
      status: "in_progress",
      phase: "命名",
      progressPercent: 0,
    });
    if (normalized.taskName !== fields.name) return undefined;
    return { version: 1, sessionInfoId: fields.sessionInfoId, name: fields.name };
  } catch {
    // 损坏的持久化归属不是自动命名授权，不回退到更早的 marker。
    return undefined;
  }
}

export function shouldUpdateSessionName(
  entries: readonly SessionNameEntryLike[],
  currentName: string | undefined,
  taskName: string,
): boolean {
  let infoIndex = -1;
  let ownerIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (infoIndex < 0 && entry.type === "session_info") infoIndex = index;
    if (ownerIndex < 0 && entry.type === "custom" && entry.customType === SESSION_NAME_OWNER_TYPE) {
      ownerIndex = index;
    }
    if (infoIndex >= 0 && ownerIndex >= 0) break;
  }
  if (infoIndex < 0) return ownerIndex < 0 && currentName === undefined;
  if (ownerIndex <= infoIndex) return false;
  const info = entries[infoIndex];
  const owner = parseOwner(entries[ownerIndex].data);
  if (!owner || owner.sessionInfoId !== info.id || owner.name !== info.name || owner.name !== currentName) {
    return false;
  }
  return currentName !== taskName;
}

export function syncSessionName(
  pi: Pick<ExtensionAPI, "getSessionName" | "setSessionName" | "appendEntry">,
  sessionManager: Pick<ExtensionContext["sessionManager"], "getEntries">,
  taskName: string,
): void {
  const entries = sessionManager.getEntries();
  if (!shouldUpdateSessionName(entries, pi.getSessionName(), taskName)) return;

  pi.setSessionName(taskName);
  const updatedEntries = sessionManager.getEntries();
  const newInfos = updatedEntries.slice(entries.length).filter((entry) => entry.type === "session_info");
  const info = newInfos[0];
  // 原生调用不返回 ID；仅在此次调用恰好追加一条名称记录时确认归属。
  if (
    newInfos.length !== 1 ||
    !info ||
    typeof info.id !== "string" ||
    !info.id ||
    info.name !== taskName ||
    pi.getSessionName() !== taskName
  ) throw new Error("无法确认自动名称对应的原生 session_info 记录，未保存名称归属");

  pi.appendEntry(SESSION_NAME_OWNER_TYPE, {
    version: 1,
    sessionInfoId: info.id,
    name: taskName,
  } satisfies SessionNameOwner);
}
