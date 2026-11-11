import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendCloseCheckpoint, validateRecoveryTranscript } from "#src/session/recovery-checkpoint";
import { assistantMessage, createRecoveryFixture } from "#test/helpers/recovery-fixture";

let fixture: ReturnType<typeof createRecoveryFixture>;
beforeEach(() => { fixture = createRecoveryFixture(); });
afterEach(() => { fixture.cleanup(); });

describe("strict cold recovery checkpoint validation", () => {
  it("accepts SDK-produced JSONL and its exact parent branch terminal receipt without writes", () => {
    const bytes = fixture.text();
    const parentBytes = readFileSync(fixture.parentFile, "utf8");
    const history = fixture.history();
    expect(history.issues).toEqual([]);
    expect(validateRecoveryTranscript(bytes, history)).toMatchObject({
      cwd: fixture.cwd, checkpoint: { terminalEntryId: fixture.terminalEntryId,
        childSessionId: fixture.child.getSessionId(), invocationIndex: 1 },
    });
    expect(fixture.text()).toBe(bytes);
    expect(readFileSync(fixture.parentFile, "utf8")).toBe(parentBytes);
  });

  const corruptions: [string, (entries: Record<string, any>[]) => void][] = [
    ["missing checkpoint", (entries) => { entries.pop(); }],
    ["new tail after checkpoint", (entries) => { entries.push({ type: "custom", id: "tail", parentId: entries.at(-1)!.id, customType: "extra" }); }],
    ["duplicate entry ID", (entries) => { entries[2].id = entries[1].id; }],
    ["broken entry parent", (entries) => { entries[2].parentId = "missing-parent"; }],
    ["wrong header version", (entries) => { entries[0].version = 2; }],
    ["wrong child identity", (entries) => { entries[0].id = "other-child"; }],
    ["wrong header parent", (entries) => { entries[0].parentSession = "other-parent"; }],
    ["changed original cwd", (entries) => { entries[0].cwd = "/another-existing-project"; }],
    ["unknown entry type", (entries) => { entries[1].type = "future-entry"; }],
    ["unknown message role", (entries) => { entries.findLast((entry) => entry.type === "message")!.message.role = "future-role"; }],
    ["wrong checkpoint terminal entry", (entries) => { entries.at(-1)!.data.terminalEntryId = "other-terminal"; }],
    ["wrong checkpoint parent branch", (entries) => { entries.at(-1)!.data.parentId = "other-parent"; }],
    ["wrong checkpoint parent file", (entries) => { entries.at(-1)!.data.parentFile = "/other-parent.jsonl"; }],
    ["wrong checkpoint index", (entries) => { entries.at(-1)!.data.invocationIndex++; }],
    ["wrong checkpoint boundary", (entries) => { entries.at(-1)!.data.boundaryId = null; }],
    ["unfinished tool call", (entries) => {
      const finalMessage = entries.findLast((entry) => entry.type === "message");
      finalMessage!.message.content = [{ type: "toolCall", id: "pending", name: "read", arguments: {} }];
    }],
    ["unmatched tool result", (entries) => {
      entries.find((entry) => entry.message?.role === "toolResult")!.message.toolCallId = "unknown";
    }],
    ["unfinished user message", (entries) => {
      entries.findLast((entry) => entry.type === "message")!.message = { role: "user", content: "unfinished", timestamp: 3 };
    }],
    ["invalid assistant usage", (entries) => {
      entries.find((entry) => entry.message?.role === "assistant")!.message.usage.input = -1;
    }],
    ["transcript cumulative usage mismatch", (entries) => {
      entries.find((entry) => entry.message?.role === "assistant")!.message.usage.input++;
    }],
  ];

  it.each(corruptions)("rejects %s without changing child or parent bytes", (_name, corrupt) => {
    const history = fixture.history();
    const entries = fixture.entries();
    corrupt(entries);
    fixture.writeEntries(entries);
    const bytes = fixture.text();
    const parentBytes = readFileSync(fixture.parentFile, "utf8");
    const files = readdirSync(fixture.childDirectory).sort();
    expect(() => validateRecoveryTranscript(bytes, history)).toThrow();
    expect(fixture.text()).toBe(bytes);
    expect(readFileSync(fixture.parentFile, "utf8")).toBe(parentBytes);
    expect(readdirSync(fixture.childDirectory).sort()).toEqual(files);
  });

  it.each([
    ["incomplete final line", (text: string) => text.trimEnd()],
    ["malformed final line", (text: string) => text + '{"type":\n'],
    ["blank line", (text: string) => text + "\n"],
  ])("rejects %s before the SDK can salvage the transcript", (_name, corrupt) => {
    expect(() => validateRecoveryTranscript(corrupt(fixture.text()), fixture.history())).toThrow();
  });

  it("accepts several complete invocation windows with exact cumulative metrics", () => {
    fixture.child.appendMessage({ role: "user", content: "second", timestamp: 3 });
    fixture.child.appendMessage(assistantMessage("second answer", 2, 1, 0));
    const resumed = { ...fixture.record, invocationKind: "resume" as const, invocationIndex: 2,
      toolCallId: "second-call", invocationUsage: { input: 2, output: 1, cacheWrite: 0, total: 3 },
      invocationToolUses: 0, invocationTurnCount: 1, lifetimeTurnCount: 3,
      lifetimeUsage: { input: 13, output: 5, cacheWrite: 3, total: 21 } };
    const terminalEntryId = fixture.parent.appendCustomEntry("subagents:record", resumed);
    appendCloseCheckpoint(fixture.child, { ...fixture.receipt, terminalEntryId, invocationIndex: 2 });
    expect(validateRecoveryTranscript(fixture.text(), fixture.history()).checkpoint.invocationIndex).toBe(2);
  });

  it.each(["usage", "tool uses", "turn count", "index"])("rejects inconsistent cumulative history: %s", (field) => {
    const history = fixture.history();
    if (field === "usage") history.latest.lifetimeUsage = { input: 12, output: 4, cacheWrite: 3, total: 19 };
    if (field === "tool uses") history.latest.lifetimeToolUses = 2;
    if (field === "turn count") history.latest.lifetimeTurnCount = 3;
    if (field === "index") history.invocations[0].record.invocationIndex = 2;
    expect(() => validateRecoveryTranscript(fixture.text(), history)).toThrow();
  });

  it("rejects v2 history despite retaining its readable result", () => {
    fixture.parent.branch(fixture.anchor);
    fixture.parent.appendCustomEntry("subagents:record", { ...fixture.record, recordVersion: 2, status: "completed" });
    const history = fixture.history();
    expect(history.latest.result).toBe("first answer");
    expect(history.invocations[0].version).toBe(2);
    expect(() => validateRecoveryTranscript(fixture.text(), history)).toThrow(/complete v3/);
  });

  it("cannot locate a record removed from the current parent branch", () => {
    fixture.parent.branch(fixture.anchor);
    expect(fixture.store.get(fixture.record.id)).toBeUndefined();
  });

  it("rejects missing child files without recreating them", () => {
    unlinkSync(fixture.file);
    const history = fixture.history();
    expect(history.outputFile).toBeUndefined();
    expect(() => validateRecoveryTranscript("", history)).toThrow(/complete v3/);
    expect(readdirSync(fixture.childDirectory)).toEqual([]);
  });

  it.each(["parent", "child"])("does not append a close checkpoint after %s identity changes", (changed) => {
    const bytes = fixture.text();
    expect(() => appendCloseCheckpoint(fixture.child, {
      ...fixture.receipt,
      ...(changed === "parent" ? { isCurrent: () => false } : { childSessionId: "other-child" }),
    })).toThrow(/identity changed/);
    expect(fixture.text()).toBe(bytes);
  });
});
