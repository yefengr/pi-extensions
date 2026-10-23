import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

export const BASE_TIME = Date.parse("2026-09-07T00:00:00.000Z");

export function timestamp(seconds: number): string {
  return new Date(BASE_TIME + seconds * 1000).toISOString();
}

export function header(version: 2 | 3 = 3, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "session",
    version,
    id: "session-test",
    timestamp: timestamp(0),
    cwd: "/workspace/demo",
    ...overrides,
  };
}

export function entry(
  type: string,
  id: string,
  parentId: string | null,
  seconds: number,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type, id, parentId, timestamp: timestamp(seconds), ...fields };
}

export function usage(): Record<string, unknown> {
  return {
    input: 10,
    output: 3,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 16,
    cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
  };
}

export function message(
  id: string,
  parentId: string | null,
  seconds: number,
  role: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return entry("message", id, parentId, seconds, {
    message: { role, timestamp: BASE_TIME + seconds * 1000, ...fields },
  });
}

export function user(
  id: string,
  parentId: string | null,
  seconds: number,
  content: unknown = "user text",
): Record<string, unknown> {
  return message(id, parentId, seconds, "user", { content });
}

export function assistant(
  id: string,
  parentId: string | null,
  seconds: number,
  content: unknown[] = [{ type: "text", text: "assistant text" }],
): Record<string, unknown> {
  return message(id, parentId, seconds, "assistant", {
    content,
    provider: "test-provider",
    model: "test-model",
    api: "test-api",
    usage: usage(),
    stopReason: "stop",
  });
}

export function toolResult(
  id: string,
  parentId: string | null,
  seconds: number,
  content: unknown = [{ type: "text", text: "tool text" }],
): Record<string, unknown> {
  return message(id, parentId, seconds, "toolResult", {
    toolCallId: "call-1",
    toolName: "read",
    content,
    isError: false,
  });
}

export function lifecycleRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recordVersion: 2,
    id: "agent-1",
    type: "deepseek-flash-standard-worker",
    description: "PRIVATE_DESCRIPTION",
    status: "completed",
    isBackground: false,
    invocationKind: "fresh",
    invocationSource: "tool",
    invocationIndex: 1,
    toolCallId: "call-1",
    sessionState: "created",
    sessionId: "child-session",
    outputFile: "/private/child.jsonl",
    startedAt: BASE_TIME + 1000,
    completedAt: BASE_TIME + 2000,
    durationMs: 1000,
    result: "private result",
    invocationToolUses: 1,
    invocationUsage: { input: 1, output: 2, cacheWrite: 3, total: 6 },
    lifetimeToolUses: 2,
    lifetimeUsage: { input: 2, output: 4, cacheWrite: 6, total: 12 },
    ...overrides,
  };
}

export function lifecycleRecordV3(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { status: _status, ...record } = lifecycleRecord();
  return {
    ...record,
    recordVersion: 3,
    phase: "terminal",
    outcome: "completed",
    invocationTurnCount: 1,
    lifetimeTurnCount: 2,
    maxTurns: 20,
    wrapUpTurns: 2,
    maxDurationSeconds: 120,
    ...overrides,
  };
}

export async function writeSession(
  t: TestContext,
  values: readonly unknown[],
  options: { readonly finalNewline?: boolean; readonly suffix?: string } = {},
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "efficiency-"));
  const filePath = path.join(directory, "session.jsonl");
  const body = values.map((value) => JSON.stringify(value)).join("\n");
  await writeFile(filePath, `${body}${options.finalNewline === false ? "" : "\n"}${options.suffix ?? ""}`, "utf8");
  t.after(() => rm(directory, { recursive: true, force: true }));
  return filePath;
}
