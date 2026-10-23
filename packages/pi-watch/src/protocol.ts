import {
  MAX_CURSOR_LENGTH, MAX_EVENT_DATA_BYTES, MAX_EVENTS_PER_CHECK, MAX_OUTPUT_BYTES, MAX_SUMMARY_LENGTH,
} from "./constants.ts";
import type { CheckResult, MonitorEvent } from "./types.ts";

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象`);
  return value as Record<string, unknown>;
}
function keys(data: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(data)) if (!allowed.includes(key)) throw new Error(`检查结果包含未知字段：${key}`);
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} 必须是非空字符串且不超过 ${max} 字符`);
  return value;
}

export function parseCheckResult(stdout: string): CheckResult {
  if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) throw new Error("检查结果超过输出上限");
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new Error("检查 stdout 必须恰好包含一个完整 JSON 对象"); }
  const data = object(parsed, "检查结果");
  if (data.state === "error") {
    keys(data, ["state", "summary"]);
    return { state: "error", summary: text(data.summary, "summary", MAX_SUMMARY_LENGTH) };
  }
  if (data.state !== "ok") throw new Error("检查 state 必须为 ok 或 error");
  keys(data, ["state", "events", "cursor"]);
  if (!Array.isArray(data.events) || data.events.length > MAX_EVENTS_PER_CHECK) throw new Error(`events 必须是数组，最多 ${MAX_EVENTS_PER_CHECK} 项`);
  if (data.cursor !== undefined && (typeof data.cursor !== "string" || data.cursor.length > MAX_CURSOR_LENGTH)) throw new Error("cursor 必须是有界字符串");
  const seen = new Set<string>();
  const events: MonitorEvent[] = [];
  for (const value of data.events) {
    const event = object(value, "事件");
    keys(event, ["id", "summary", "data"]);
    const id = text(event.id, "事件 id", 256);
    if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(id)) throw new Error("事件 id 不允许控制字符或双向文本控制符");
    const summary = text(event.summary, "事件 summary", MAX_SUMMARY_LENGTH);
    if (event.data !== undefined && Buffer.byteLength(JSON.stringify(event.data), "utf8") > MAX_EVENT_DATA_BYTES) throw new Error("事件 data 超过字节上限");
    if (seen.has(id)) continue;
    seen.add(id);
    events.push({ id, summary, ...(event.data === undefined ? {} : { data: event.data }) });
  }
  return { state: "ok", events, ...(typeof data.cursor === "string" ? { cursor: data.cursor } : {}) };
}
