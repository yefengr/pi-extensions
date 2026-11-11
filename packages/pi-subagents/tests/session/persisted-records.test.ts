import { basename, dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { buildLifecycleRecord } from "#src/lifecycle/lifecycle-record";
import { PersistedSubagentStore } from "#src/session/persisted-records";
import { GetResultTool } from "#src/tools/get-result-tool";
import { createTestSubagent } from "#test/helpers/make-subagent";

function fixture() {
  // 生产查询对记录路径和候选文件调用原生 resolve/relative；夹具必须用同一平台规范化，
  // 否则 Windows 上 POSIX 字面量会被解析成带盘符的路径，与 mock 的 Map 键不一致。
  const workspace = resolve("sessions", "fixture");
  const parentFile = resolve(workspace, "parent.jsonl");
  // 与 PersistedSubagentStore 的 tasks 目录推导保持一致。
  const childDirectory = join(dirname(parentFile), basename(parentFile, ".jsonl"), "tasks");
  const file = join(childDirectory, "child.jsonl");
  const copyFile = join(childDirectory, "copy.jsonl");
  const outsideFile = resolve(workspace, "outside", "child.jsonl");
  const record = buildLifecycleRecord(createTestSubagent({ id: "saved", outputFile: file }));
  const entry = { type: "custom", id: "terminal-entry", customType: "subagents:record", data: record };
  const parent = { id: "parent-id", file: parentFile, entries: [entry] as unknown[] };
  const files = new Map([[file, JSON.stringify({ type: "session", version: 3, id: record.sessionId,
    parentSession: parent.id, cwd: resolve(workspace, "project") }) + "\n"]]);
  const readFile = vi.fn((path: string) => {
    const content = files.get(path);
    if (content === undefined) throw new Error("ENOENT");
    return content;
  });
  const store = new PersistedSubagentStore(() => parent, {
    readFile, realpath: (path) => path,
    listFiles: () => [...files.keys()],
  });
  return { file, copyFile, outsideFile, record, entry, parent, files, readFile, store };
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
    const { store, files, file, copyFile } = fixture();
    files.set(copyFile, files.get(file)!);
    const saved = store.get("saved")!;
    expect(saved.outputFile).toBeUndefined();
    expect(saved.issues.join()).toContain("Multiple");
  });

  it("does not follow a transcript outside the original child directory", () => {
    const { store, files, file, outsideFile, record } = fixture();
    files.set(outsideFile, files.get(file)!);
    files.delete(file);
    record.outputFile = outsideFile;
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
    const { store, files, file, outsideFile, record } = fixture();
    files.set(outsideFile, files.get(file)!);
    record.outputFile = outsideFile;
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
