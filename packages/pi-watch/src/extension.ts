import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { NOTIFICATION_TYPE, RESULT_TYPE } from "./constants.ts";
import { openTaskPanel } from "./panel.ts";
import { formatBatchText, formatTaskLines, formatTaskText, isActiveTask, safeText, taskSummary, type BatchView } from "./presentation.ts";
import { MonitorRuntime, receiptFromMessage, type RuntimeDependencies } from "./runtime.ts";

const parameters = Type.Object({
  action: Type.Union([Type.Literal("start"), Type.Literal("list"), Type.Literal("status"), Type.Literal("stop"), Type.Literal("resume")]),
  id: Type.Optional(Type.String()), batchId: Type.Optional(Type.String()), eventId: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  purpose: Type.Optional(Type.String()), explanation: Type.Optional(Type.String()),
  mode: Type.Optional(Type.Union([Type.Literal("once"), Type.Literal("continuous")])),
  delivery: Type.Optional(Type.Union([Type.Literal("explain"), Type.Literal("notify")])),
  command: Type.Optional(Type.String()), args: Type.Optional(Type.Array(Type.String())),
  cwd: Type.Optional(Type.String()), intervalSeconds: Type.Optional(Type.Number()),
  timeoutSeconds: Type.Optional(Type.Number()), maxDurationSeconds: Type.Optional(Type.Number()),
  logLevel: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("info"), Type.Literal("debug")])),
  autoResume: Type.Optional(Type.Boolean()), all: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

interface ToolTask {
  id: string; name: string; status: string; failures: number; pendingBatches: number;
}

interface ToolDetails {
  tasks: ToolTask[];
  summary?: string;
}

const ACTION_LABEL: Record<string, string> = {
  start: "已注册", stop: "已停止", resume: "已恢复",
};

/** 折叠态调用行：只保留 action 与任务名，避免长参数被截断成不可读片段。 */
function callText(args: Record<string, unknown>, expanded: boolean, theme: Theme): string {
  const action = typeof args.action === "string" ? args.action : "";
  const name = typeof args.name === "string" ? args.name : undefined;
  const head = `${theme.fg("toolTitle", theme.bold("watch"))} ${theme.fg("accent", action)}`;
  if (!expanded) return name ? `${head} ${theme.fg("muted", `· ${name}`)}` : head;
  const lines = [head];
  for (const [key, value] of Object.entries(args)) {
    if (key === "action") continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    lines.push(theme.fg("muted", `  ${key}: ${text}`));
  }
  return lines.join("\n");
}

function contentText(content: ReadonlyArray<{ type: string }>): string {
  return content
    .filter((part) => part.type === "text")
    .map((part) => (part as unknown as { text: string }).text)
    .join("\n");
}

/** 折叠态结果行：一行统计；展开态直接复用工具 text。 */
function resultText(details: ToolDetails | undefined, content: ReadonlyArray<{ type: string }>, expanded: boolean, theme: Theme): string {
  if (expanded) return contentText(content);
  const tasks = details?.tasks ?? [];
  if (!tasks.length) return theme.fg("muted", details?.summary ?? "无变化");
  if (tasks.length === 1) {
    const task = tasks[0];
    const attention = task.status === "paused" || task.failures > 0;
    const mark = attention ? theme.fg("warning", "!") : theme.fg("success", "✓");
    const tail = [task.status, task.failures ? `失败 ${task.failures}` : undefined, task.pendingBatches ? `待回传 ${task.pendingBatches}` : undefined]
      .filter(Boolean).join(" · ");
    return `${mark} ${theme.fg("text", task.name)} ${theme.fg("muted", `· ${tail}`)}`;
  }
  const running = tasks.filter((task) => task.status === "running").length;
  const paused = tasks.filter((task) => task.status === "paused").length;
  const pending = tasks.filter((task) => task.pendingBatches > 0).length;
  return `${theme.fg("success", "✓")} ${theme.fg("text", `${tasks.length} 个`)} ${theme.fg("muted", `· 运行 ${running} · 暂停 ${paused} · 待回传 ${pending}`)}`;
}

export function registerMonitor(pi: ExtensionAPI, deps: RuntimeDependencies = {}): MonitorRuntime {
  const runtime = new MonitorRuntime(pi, deps);
  pi.on("session_start", (event, ctx) => runtime.startSession(ctx, event.reason));
  pi.on("session_shutdown", () => runtime.dispose());
  pi.on("session_before_tree", () => runtime.beforeTree());
  pi.on("session_tree", (_event, ctx) => runtime.startSession(ctx, "tree"));
  pi.on("agent_settled", () => runtime.settled());
  pi.on("before_agent_start", (event) => {
    const isResult = event.messageType === "custom" && event.message.customType === RESULT_TYPE;
    const receipt = isResult ? receiptFromMessage(event.message) : undefined;
    runtime.beforeRun(isResult, receipt?.deliveries.map((item) => item.taskId) ?? []);
  });
  pi.on("message_end", (event) => {
    const receipt = receiptFromMessage(event.message);
    if (receipt) runtime.onReceipt(receipt);
  });
  pi.on("tool_call", (event) => {
    if (!runtime.isExplanationOnly()) return;
    const input = event.input as { action?: unknown; id?: unknown };
    if (event.toolName === "watch") {
      if (input.action === "status" || input.action === "list") return;
      if (input.action === "stop" && runtime.canStopInExplanation(input.id)) return;
    }
    return { block: true, reason: "本轮由监听结果触发，只允许解释结果、只读查看 watch 状态或停止本次结果所属的监听。其他操作需要用户在新的请求中独立授权。" };
  });

  pi.registerTool({
    name: "watch", label: "后台监听", exposure: "model-only",
    description: "注册或管理当前会话的后台命令监听。start 必须明确 once/continuous，并给出 name、purpose、command、args、cwd；start/resume 直接执行、不弹用户确认，由模型结合用户请求判断；命令以当前用户权限运行、非沙箱。检查stdout须为{state:'ok',events:[{id,summary,data?}],cursor?}或{state:'error',summary}。stdin提供{monitorId,cursor}。无新事件不调用模型。有新结果仅解释（可停止本次结果所属的监听），不执行其他操作。纯通知选delivery=notify。日志默认 logLevel=info，写入任务 cwd 所属项目的 .pi/logs/watch/，包含事件摘要；排查时显式设 debug，off 关闭。stop只停止检查，不停止远端任务；status/list只读。autoResume=true 时，重启 Pi 或切回会话后自动续跑该监听；默认暂停并等待 resume。禁止将密码/Token写入参数。",
    parameters,
    outputSchema: Type.Object({ tasks: Type.Array(Type.Unknown()), summary: Type.Optional(Type.String()) }),
    renderCall(args, theme, context) {
      return new Text(callText(args as Record<string, unknown>, context.expanded, theme), 0, 0);
    },
    renderResult(result, options, theme) {
      const details = result.details as ToolDetails | undefined;
      return new Text(resultText(details, result.content, options.expanded, theme), 0, 0);
    },
    async execute(_id, input, signal, _onUpdate, ctx) {
      let tasks: unknown[];
      let summary: string | undefined;
      let text: string;
      if (input.action === "list") {
        const records = runtime.records(ctx);
        tasks = (input.all ? records : records.filter(isActiveTask)).map(taskSummary);
        text = formatTaskLines(records, { all: input.all === true });
      } else if (input.action === "status") {
        if (!input.id) throw new Error("status 必须提供 id");
        const value = runtime.query(ctx, input.id, input.batchId, input.eventId);
        tasks = [value];
        text = input.batchId
          ? formatBatchText(value as BatchView)
          : formatTaskText(runtime.record(ctx, input.id));
      } else {
        const record = await runtime.act(input.action as "start" | "stop" | "resume", input, ctx, signal);
        tasks = record ? [taskSummary(record)] : [];
        if (record) text = `${ACTION_LABEL[input.action]} ${record.name} · ${record.status}`;
        else { summary = "操作已取消，没有启动或恢复监听"; text = summary; }
      }
      const result = { tasks, ...(summary ? { summary } : {}) };
      return { content: [{ type: "text", text: safeText(text) }], details: result, structuredContent: JSON.parse(JSON.stringify(result)) };
    },
  });

  pi.registerCommand("watch", {
    description: "后台监听：list / show <id> [batchId] [eventId] / stop <id> / resume <id> / start <JSON>",
    handler: async (args, ctx) => {
      try {
        const [action = "list", ...rest] = args.trim().split(/\s+/);
        const tail = rest.join(" ");
        if (action === "list") {
          const all = rest[0] === "all";
          if (ctx.mode === "tui") return await openTaskPanel(runtime, ctx, undefined, all, pi.getSettings().outputPad ?? 1);
          ctx.ui.notify(safeText(formatTaskLines(runtime.records(ctx), { all })), "info");
          return;
        }
        if (action === "show" || action === "status") {
          const id = rest[0];
          if (!id) throw new Error("用法：/watch show <id> [batchId] [eventId]");
          if (ctx.mode === "tui" && !rest[1]) return await openTaskPanel(runtime, ctx, runtime.record(ctx, id).id, false, pi.getSettings().outputPad ?? 1);
          const batchId = rest[1];
          const text = batchId
            ? formatBatchText(runtime.query(ctx, id, batchId, rest.slice(2).join(" ") || undefined) as BatchView)
            : formatTaskText(runtime.record(ctx, id));
          ctx.ui.notify(safeText(text), "info");
          return;
        }
        if (action !== "start" && action !== "stop" && action !== "resume") throw new Error("用法：/watch list | show <id> | stop <id> | resume <id> | start <JSON>");
        const input = action === "start" ? JSON.parse(args.slice(args.indexOf("start") + 5).trim()) : { id: tail };
        const record = await runtime.act(action, input, ctx);
        ctx.ui.notify(record ? safeText(`监听 ${record.name}：${record.status}`) : "已取消", "info");
      } catch (error) { ctx.ui.notify(safeText(error instanceof Error ? error.message : String(error)), "error"); }
    },
  });
  // notify 模式的内容也是 Markdown，交给默认渲染器会保留原始标记，因此显式渲染。
  pi.registerEntryRenderer<{ content: string }>(NOTIFICATION_TYPE, (entry) =>
    new Markdown(entry.data?.content ?? "监听收到新结果", 1, 0, getMarkdownTheme()));
  return runtime;
}
