import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_INTERVAL_MS, DEFAULT_LOG_LEVEL, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_INTERVAL_MS,
} from "./constants.ts";
import type { LogLevel, MonitorDefinition } from "./types.ts";

export interface StartInput {
  name: string;
  purpose: string;
  explanation?: string;
  mode: "once" | "continuous";
  delivery?: "explain" | "notify";
  command: string;
  args?: string[];
  cwd?: string;
  intervalSeconds?: number;
  timeoutSeconds?: number;
  maxDurationSeconds?: number;
  logLevel?: LogLevel;
  autoResume?: boolean;
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new Error(`${name} 必须是非空字符串，最长 ${max} 字符，且不含 NUL`);
  }
  return value;
}

function seconds(value: unknown, fallback: number, name: string, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} 必须在 ${min}–${max} 秒之间`);
  }
  return Math.round(value * 1_000);
}

function logLevel(value: unknown): LogLevel {
  if (value === undefined) return DEFAULT_LOG_LEVEL;
  if (value !== "off" && value !== "info" && value !== "debug") throw new Error("logLevel 必须是 off、info 或 debug");
  return value;
}

/** 只拦截常见的明文凭据写法；模型仍需核对命令的目的与权限。 */
export function rejectInlineSecrets(command: string, args: string[]): void {
  const value = [command, ...args].join(" ");
  const flags = /(?:--?(?:password|passwd|token|api[-_]?key|secret|authorization)(?:\s|=)|(?:^|[?&\s"'[{,])(?:password|passwd|token|api[_-]?key|secret|authorization)\s*["']?\s*[:=])/i;
  if (flags.test(value) || /[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i.test(value)) {
    throw new Error("命令可能包含明文凭据；请使用现有环境变量、凭据文件或系统凭据管理器");
  }
}

export function makeDefinition(input: unknown, cwd: string, ownerSessionId: string, now = Date.now()): MonitorDefinition {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("start 参数必须是对象");
  const data = input as Record<string, unknown>;
  const allowed = new Set(["action", "name", "purpose", "explanation", "mode", "delivery", "command", "args", "cwd", "intervalSeconds", "timeoutSeconds", "maxDurationSeconds", "logLevel", "autoResume"]);
  for (const key of Object.keys(data)) if (!allowed.has(key)) throw new Error(`未知的 start 参数：${key}`);
  if (data.mode !== "once" && data.mode !== "continuous") throw new Error("必须明确 mode：once 或 continuous");
  if (data.delivery !== undefined && data.delivery !== "explain" && data.delivery !== "notify") throw new Error("delivery 必须是 explain 或 notify");
  if (data.autoResume !== undefined && typeof data.autoResume !== "boolean") throw new Error("autoResume 必须是布尔值");
  const command = text(data.command, "command", 4_096);
  const args = data.args ?? [];
  if (!Array.isArray(args) || args.length > 64 || args.some((arg) => typeof arg !== "string" || arg.length > 16_384 || arg.includes("\0"))) {
    throw new Error("args 必须是字符串数组，最多 64 项，每项最多 16384 字符且不含 NUL");
  }
  rejectInlineSecrets(command, args);
  const directory = path.resolve(cwd, data.cwd === undefined ? "." : text(data.cwd, "cwd", 4_096));
  if (!statSync(directory).isDirectory()) throw new Error("cwd 不是目录");
  const duration = data.maxDurationSeconds === undefined ? undefined
    : seconds(data.maxDurationSeconds, 0, "maxDurationSeconds", 1, 365 * 24 * 3_600);
  return {
    id: randomUUID(), ownerSessionId,
    name: text(data.name, "name", 120), purpose: text(data.purpose, "purpose", 1_000),
    explanation: data.explanation === undefined ? "解释新事件的含义与需要用户关注的事项，不执行任何后续操作。" : text(data.explanation, "explanation", 1_000),
    mode: data.mode, delivery: data.delivery === "notify" ? "notify" : "explain",
    command, args: [...args], cwd: directory,
    intervalMs: seconds(data.intervalSeconds, DEFAULT_INTERVAL_MS, "intervalSeconds", MIN_INTERVAL_MS / 1_000, 86_400),
    timeoutMs: seconds(data.timeoutSeconds, DEFAULT_TIMEOUT_MS, "timeoutSeconds", 0.1, MAX_TIMEOUT_MS / 1_000),
    logLevel: logLevel(data.logLevel),
    createdAt: now, ...(duration === undefined ? {} : { deadlineAt: now + duration }),
    ...(data.autoResume === true ? { autoResume: true } : {}),
  };
}
