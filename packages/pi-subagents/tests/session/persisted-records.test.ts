import { describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { buildLifecycleRecord } from "#src/lifecycle/lifecycle-record";
import { PersistedSubagentStore } from "#src/session/persisted-records";
import { GetResultTool } from "#src/tools/get-result-tool";
import { createTestSubagent } from "#test/helpers/make-subagent";

function fixture() {
  const file = "/sessions/parent/tasks/child.jsonl";
  const record = buildLifecycleRecord(createTestSubagent({ id: "saved", outputFile: file }));
  const entry = { type: "custom", id: "terminal-entry", customType: "subagents:record", data: record };
  const parent = { id: "parent-id", file: "/sessions/parent.jsonl", entries: [entry] as unknown[] };
  const files = new Map([[file, JSON.stringify({ type: "session", version: 3, id: record.sessionId,
    parentSession: parent.id, cwd: "/project" }) + "\n"]]);
  const readFile = vi.fn((path: string) => {
    const content = files.get(path);
    if (content === undefined) throw new Error("ENOENT");
    return content;
  });
  const store = new PersistedSubagentStore(() => parent, {
    readFile, realpath: (path) => path,
    listFiles: () => [...files.keys()],
  });
  return { file, record, entry, parent, files, readFile, store };
}

describe("persisted subagent lookup", () => {
  it("reads a real producer's v3 record without constructing a live agent", () => {
    const { store, record, file } = fixture();
    const saved = store.get("saved")!;
    expect(saved.latest).toEqual(record);
    expect(saved.outputFile).toBe(file);
    expect(saved.issues).toEqual([]);
    expect(saved.invocations[0].entryId).toBe("terminal-entry");
  });

  it("only reads lifecycle records on the supplied current branch", () => {
    const { store, parent } = fixture();
    parent.entries = [];
    expect(store.get("saved")).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it("reports unsupported record versions instead of hiding them", () => {
    const { store, entry } = fixture();
    Object.assign(entry.data, { recordVersion: 99 });
    expect(() => store.get("saved")).toThrow("Unsupported");
  });

  it("preserves results when the child file is missing", () => {
    const { store, files, record } = fixture();
    files.clear();
    expect(store.get("saved")).toMatchObject({ latest: record, outputFile: undefined });
    expect(store.get("saved")!.issues.join()).toContain("missing");
  });

  it("refuses ambiguous duplicate child identities", () => {
    const { store, files, file } = fixture();
    files.set("/sessions/parent/tasks/copy.jsonl", files.get(file)!);
    const saved = store.get("saved")!;
    expect(saved.outputFile).toBeUndefined();
    expect(saved.issues.join()).toContain("Multiple");
  });

  it("does not follow a transcript outside the original child directory", () => {
    const { store, files, file, record } = fixture();
    files.set("/outside/child.jsonl", files.get(file)!);
    files.delete(file);
    record.outputFile = "/outside/child.jsonl";
    expect(store.get("saved")!.outputFile).toBeUndefined();
  });

  it("marks a malformed child tail while retaining the saved result", async () => {
    const { store, file, files, record } = fixture();
    files.set(file, files.get(file)! + '{"type":"message"');
    expect(store.get("saved")!.issues.join()).toContain("malformed JSONL tail");
    const tool = new GetResultTool({ getRecord: vi.fn(() => undefined) }, new AgentTypeRegistry(() => new Map()), store);
    const result = await tool.execute("query", { agent_id: "saved", verbose: true }, new AbortController().signal, undefined, undefined);
    expect(result.content[0].text).toContain(record.result!);
    expect(result.content[0].text).toContain("incomplete");
  });

  it("rejects an out-of-directory recorded path even when a matching in-directory copy exists", () => {
    const { store, files, file, record } = fixture();
    files.set("/outside/child.jsonl", files.get(file)!);
    record.outputFile = "/outside/child.jsonl";
    const saved = store.get("saved")!;
    expect(saved.latest.result).toBe(record.result);
    expect(saved.outputFile).toBeUndefined();
    expect(saved.issues.join()).toContain("outside its original");
  });

  it("checks the child's parent identity", () => {
    const { store, files, file, record } = fixture();
    files.set(file, JSON.stringify({ type: "session", id: record.sessionId, parentSession: "other" }));
    expect(store.get("saved")!.issues.join()).toContain("different parent");
  });

  it("keeps v2 results readable without making up restoration evidence", () => {
    const { store, entry } = fixture();
    Object.assign(entry.data, { recordVersion: 2, status: "aborted", phase: undefined, outcome: undefined });
    const saved = store.get("saved")!;
    expect(saved.invocations[0].version).toBe(2);
    expect(saved.latest.outcome).toBe("cancelled");
  });

  it("rejects malformed metrics and records duplicate invocation indices", () => {
    const { store, entry, parent } = fixture();
    parent.entries.push({ ...entry, id: "duplicate" });
    expect(store.get("saved")!.issues.join()).toContain("identity");
    entry.data.invocationUsage.total = -1;
    expect(() => store.get("saved")).toThrow("metrics");
  });

  it("returns a persisted result without running or hydrating an agent", async () => {
    const { store, record } = fixture();
    const manager = { getRecord: vi.fn(() => undefined) };
    const tool = new GetResultTool(manager, new AgentTypeRegistry(() => new Map()), store);
    const result = await tool.execute("query", { agent_id: "saved", wait: true }, new AbortController().signal, undefined, undefined);
    expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(record.result!) })]));
    expect(manager.getRecord).toHaveBeenCalledExactlyOnceWith("saved");
  });
});
