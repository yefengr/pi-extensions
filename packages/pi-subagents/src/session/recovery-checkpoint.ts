import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SubagentLifecycleRecordV3 } from "#src/lifecycle/lifecycle-record";
import type { SavedAgentHistory } from "#src/session/persisted-records";

export const CLOSE_CHECKPOINT_TYPE = "subagents:closed-private";
export interface RecoveryCheckpoint {
  version: 1;
  parentId: string;
  parentFile: string;
  terminalEntryId: string;
  agentId: string;
  agentType: string;
  childSessionId: string;
  cwd: string;
  invocationIndex: number;
  boundaryId: string | null;
}
export interface CheckpointManager {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getCwd(): string;
  getLeafId(): string | null;
  appendCustomEntry(customType: string, data: unknown): string;
}
export interface TerminalReceipt {
  parentId: string;
  parentFile: string;
  terminalEntryId: string;
  agentId: string;
  agentType: string;
  childSessionId: string;
  invocationIndex: number;
  /** Must still identify the original parent and exact terminal entry when closing. */
  isCurrent(): boolean;
}

export function appendCloseCheckpoint(manager: CheckpointManager, receipt: TerminalReceipt): void {
  if (!receipt.isCurrent() || manager.getSessionId() !== receipt.childSessionId) {
    throw new Error("Parent or child identity changed before checkpoint");
  }
  const { isCurrent: _isCurrent, ...identity } = receipt;
  const data: RecoveryCheckpoint = { ...identity, version: 1, cwd: manager.getCwd(), boundaryId: manager.getLeafId() };
  manager.appendCustomEntry(CLOSE_CHECKPOINT_TYPE, data);
}

const ENTRY_TYPES = new Set<SessionEntry["type"]>([
  "message", "thinking_level_change", "model_change", "usage", "compaction", "branch_summary",
  "custom", "label", "session_info", "custom_message", "context_edit",
]);

type JsonObject = Record<string, any>;
function object(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Validate the bytes before SDK.open: never let SDK salvage or migrate recovery input. */
export function validateRecoveryTranscript(text: string, history: SavedAgentHistory): { cwd: string; checkpoint: RecoveryCheckpoint } {
  if (history.issues.length || !history.outputFile || history.invocations.some((item) => item.version !== 3)) {
    throw new Error(`Cold resume requires complete v3 history: ${history.issues.join("; ")}`);
  }
  if (!text.endsWith("\n")) throw new Error("Child transcript has an incomplete final line");
  const lines = text.slice(0, -1).split("\n");
  const entries = lines.map((line) => {
    const entry: unknown = JSON.parse(line);
    if (!object(entry)) throw new Error("Invalid child JSONL entry");
    return entry;
  });
  const [header, ...body] = entries;
  const latest = history.latest;
  if (header?.type !== "session" || header.version !== 3 || header.id !== latest.sessionId
    || typeof header.cwd !== "string" || !header.cwd
    || (header.parentSession !== history.parent.id && header.parentSession !== history.parent.file)) {
    throw new Error("Child transcript header identity/version does not match history");
  }
  const ids = new Set<string>();
  for (const entry of body) {
    if (!ENTRY_TYPES.has(entry.type) || typeof entry.id !== "string" || !entry.id || ids.has(entry.id)
      || (entry.parentId !== null && !ids.has(entry.parentId))) throw new Error("Broken child entry tree or duplicate ID");
    ids.add(entry.id);
  }
  const final = body.at(-1);
  const checkpoint = final?.data as RecoveryCheckpoint | undefined;
  if (final?.type !== "custom" || final.customType !== CLOSE_CHECKPOINT_TYPE || !object(checkpoint)
    || checkpoint.version !== 1 || checkpoint.cwd !== header.cwd || checkpoint.boundaryId !== final.parentId
    || final.parentId !== (body.at(-2)?.id ?? null)
    || checkpoint.agentId !== latest.id || checkpoint.agentType !== latest.type
    || checkpoint.childSessionId !== latest.sessionId || checkpoint.invocationIndex !== latest.invocationIndex
    || checkpoint.parentId !== history.parent.id || checkpoint.parentFile !== history.parent.file
    || checkpoint.terminalEntryId !== history.invocations.at(-1)?.entryId) {
    throw new Error("Missing or stale private close checkpoint");
  }
  assertHistoryTotals(history);
  assertTranscriptTotals(body, latest);
  return { cwd: header.cwd, checkpoint };
}

function assertHistoryTotals(history: SavedAgentHistory): void {
  const sums = { input: 0, output: 0, cacheWrite: 0, tools: 0, turns: 0 };
  history.invocations.forEach(({ record }, index) => {
    sums.input += record.invocationUsage.input;
    sums.output += record.invocationUsage.output;
    sums.cacheWrite += record.invocationUsage.cacheWrite;
    sums.tools += record.invocationToolUses;
    sums.turns += record.invocationTurnCount;
    if (record.invocationIndex !== index + 1 || record.id !== history.latest.id
      || record.type !== history.latest.type || record.sessionId !== history.latest.sessionId
      || sums.input !== record.lifetimeUsage.input || sums.output !== record.lifetimeUsage.output
      || sums.cacheWrite !== record.lifetimeUsage.cacheWrite || sums.tools !== record.lifetimeToolUses
      || sums.turns !== record.lifetimeTurnCount) throw new Error("Inconsistent invocation windows or lifetime totals");
  });
}

function assertTranscriptTotals(entries: JsonObject[], latest: SubagentLifecycleRecordV3): void {
  const pending = new Set<string>();
  const sums = { input: 0, output: 0, cacheWrite: 0, tools: 0, turns: 0 };
  let lastRole: unknown;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!object(message) || !["system", "assistant", "user", "toolResult", "bashExecution", "custom", "branchSummary", "compactionSummary"].includes(message.role)) {
      throw new Error(`Invalid or unsupported transcript message role: ${String(message?.role)}`);
    }
    lastRole = message.role;
    if (message.role === "assistant") {
      if (!object(message.usage) || !Array.isArray(message.content)) throw new Error("Missing assistant usage");
      for (const field of ["input", "output", "cacheWrite"] as const) {
        if (!Number.isFinite(message.usage[field]) || message.usage[field] < 0) throw new Error("Invalid assistant usage");
        sums[field] += message.usage[field];
      }
      sums.turns++;
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        if (typeof block.id !== "string" || pending.has(block.id)) throw new Error("Invalid tool call identity");
        pending.add(block.id);
      }
    }
    if (message.role === "toolResult") {
      if (!pending.delete(message.toolCallId)) throw new Error("Unmatched tool result");
      sums.tools++;
    }
  }
  if (pending.size || lastRole === "user" || lastRole === "toolResult") throw new Error("Child transcript contains unfinished work");
  if (sums.input !== latest.lifetimeUsage.input || sums.output !== latest.lifetimeUsage.output
    || sums.cacheWrite !== latest.lifetimeUsage.cacheWrite || sums.tools !== latest.lifetimeToolUses
    || sums.turns !== latest.lifetimeTurnCount) throw new Error("Transcript metrics do not match terminal history");
}
