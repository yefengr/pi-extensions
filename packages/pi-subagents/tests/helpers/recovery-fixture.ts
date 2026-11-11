import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SubagentLifecycleRecordV3 } from "#src/lifecycle/lifecycle-record";
import type { Subagent } from "#src/lifecycle/subagent";
import { SubagentEventsObserver } from "#src/observation/subagent-events-observer";
import { PersistedSubagentStore } from "#src/session/persisted-records";
import { appendCloseCheckpoint, type TerminalReceipt } from "#src/session/recovery-checkpoint";

export function assistantMessage(text = "finished", input = 7, output = 3, cacheWrite = 2): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages",
    provider: "offline-recovery", model: "offline-recovery-model", stopReason: "stop", timestamp: 1,
    usage: { input, output, cacheWrite, cacheRead: 0, totalTokens: input + output + cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

/** 真正由 SDK 写出的树和父记录；每个调用拥有独立临时目录。 */
export function createRecoveryFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "subagent-recovery-")));
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const parent = SessionManager.create(cwd, join(root, "sessions"));
  const anchor = parent.appendMessage(assistantMessage("parent anchor", 0, 0, 0));
  const parentFile = parent.getSessionFile()!;
  const childDirectory = join(dirname(parentFile), basename(parentFile, ".jsonl"), "tasks");
  mkdirSync(childDirectory, { recursive: true });
  const child = SessionManager.create(cwd, childDirectory, { parentSession: parent.getSessionId() });
  child.appendMessage({ role: "user", content: "first task", timestamp: 1 });
  const toolRequest = assistantMessage("", 4, 1, 1);
  toolRequest.content = [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "file.txt" } }];
  toolRequest.stopReason = "toolUse";
  child.appendMessage(toolRequest);
  child.appendMessage({ role: "toolResult", toolCallId: "read-1", toolName: "read",
    content: [{ type: "text", text: "fixture content" }], isError: false, timestamp: 2 });
  child.appendMessage(assistantMessage("first answer"));
  const file = child.getSessionFile()!;
  const record: SubagentLifecycleRecordV3 = {
    recordVersion: 3, id: "saved-agent", type: "Explore", description: "saved description",
    phase: "terminal", outcome: "completed", isBackground: false,
    invocationKind: "fresh", invocationSource: "tool", toolCallId: "first-call", invocationIndex: 1,
    sessionState: "created", sessionId: child.getSessionId(), outputFile: file,
    startedAt: 10, completedAt: 20, durationMs: 10, result: "first answer",
    invocationUsage: { input: 11, output: 4, cacheWrite: 3, total: 18 },
    lifetimeUsage: { input: 11, output: 4, cacheWrite: 3, total: 18 },
    invocationToolUses: 1, lifetimeToolUses: 1, invocationTurnCount: 2, lifetimeTurnCount: 2,
    maxTurns: 8, wrapUpTurns: 2, maxDurationSeconds: 60,
  };
  const terminalEntryId = parent.appendCustomEntry("subagents:record", record);
  const receipt: TerminalReceipt = {
    parentId: parent.getSessionId(), parentFile, terminalEntryId, agentId: record.id,
    agentType: record.type, childSessionId: child.getSessionId(), invocationIndex: 1, isCurrent: () => true,
  };
  appendCloseCheckpoint(child, receipt);
  const store = new PersistedSubagentStore(() => ({
    id: parent.getSessionId(), file: parentFile, entries: parent.getBranch(),
  }));
  return {
    root, cwd, parent, child, parentFile, childDirectory, file, record, anchor, terminalEntryId, receipt, store,
    history: () => store.get(record.id)!,
    text: () => readFileSync(file, "utf8"),
    entries: (): Record<string, any>[] => readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line)),
    writeEntries: (entries: readonly unknown[]) => writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Exercise the production observer, including the durable parent-terminal receipt. */
export function persistTerminal(parent: SessionManager, agent: Subagent, parentAvailable: () => boolean = () => true): void {
  const observer = new SubagentEventsObserver({
    emit: () => {}, notifications: { sendCompletion: () => {}, dispose: () => {} },
    appendEntry: (type, data) => { parent.appendCustomEntry(type, data); },
    getParent: () => parentAvailable() ? { id: parent.getSessionId(), file: parent.getSessionFile()!, entries: parent.getBranch() } : undefined,
  });
  if (agent.invocationIndex === 1) observer.onSubagentCompleted(agent);
  else observer.onSubagentResumed(agent);
}
