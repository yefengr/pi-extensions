export type MonitorMode = "once" | "continuous";
export type DeliveryMode = "explain" | "notify";
export type MonitorStatus = "running" | "paused" | "stopped" | "completed" | "expired";
/** info 默认记录调度与事件摘要；debug 需显式开启，额外记录命令参数与事件数据预览。 */
export type LogLevel = "off" | "info" | "debug";
export type LogAction = "start" | "check" | "pause" | "resume" | "stop" | "complete" | "expire" | "deliver" | "deliver-error" | "receipt-error";

export interface MonitorLogEntry {
  action: LogAction;
  /** 缺省为 info；debug 条目只在任务 logLevel 为 debug 时写入。 */
  level?: "info" | "debug";
  [key: string]: unknown;
}

export interface MonitorEvent {
  id: string;
  summary: string;
  data?: unknown;
}

/** cursor 是检查命令维护的不透明增量检查点，不是业务状态。 */
export type CheckResult =
  | { state: "ok"; events: MonitorEvent[]; cursor?: string }
  | { state: "error"; summary: string };

export interface MonitorDefinition {
  id: string;
  ownerSessionId: string;
  name: string;
  purpose: string;
  explanation: string;
  mode: MonitorMode;
  delivery: DeliveryMode;
  command: string;
  args: string[];
  cwd: string;
  intervalMs: number;
  timeoutMs: number;
  createdAt: number;
  deadlineAt?: number;
  /** 重启 Pi（startup）或切回会话（resume）时自动续跑；reload 始终自动续跑。 */
  autoResume?: boolean;
  logLevel: LogLevel;
}

export interface ResultBatch {
  id: string;
  taskId: string;
  checkedAt: number;
  events: MonitorEvent[];
}

export interface MonitorRecord extends MonitorDefinition {
  status: MonitorStatus;
  pauseReason?: string;
  resumeStatus?: "running" | "completed" | "stopped" | "expired";
  nextCheckAt: number;
  lastCheckAt?: number;
  failures: number;
  lastError?: string;
  cursor?: string;
  seenIds: string[];
  pending: ResultBatch[];
  lastResult?: ResultBatch;
}

export interface EngineOptions {
  check: (record: MonitorRecord, signal: AbortSignal) => Promise<CheckResult>;
  /** 同步保存成功后才能发布内存状态，抛错表示本次变更没有提交。 */
  save: (record: MonitorRecord) => void;
  changed: () => void;
  now?: () => number;
  maxConcurrent?: number;
  maxFailures?: number;
  maxSeenIds?: number;
  maxPendingBatches?: number;
  /** 日志为 best-effort 诊断数据，抛错不得影响调度与状态提交。 */
  log?: (task: MonitorRecord, entry: MonitorLogEntry) => void;
}

export interface DeliveryReceipt {
  ownerSessionId: string;
  deliveries: Array<{ taskId: string; batchIds: string[] }>;
}
