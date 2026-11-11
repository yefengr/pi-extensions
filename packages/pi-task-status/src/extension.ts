import { randomUUID } from "node:crypto";
import {
  keyHint,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Static } from "typebox";
import { loadTaskStatusConfig } from "./config.ts";
import { formatTaskStatusResult } from "./render.ts";
import { isTaskEfficiencyReviewSession } from "./review-session.ts";
import { syncSessionName } from "./session-name.ts";
import {
  formatFallbackStatus,
  formatTaskStatus,
  StatusInputError,
} from "./status.ts";
import {
  applyStatusUpdate,
  countUserMessages,
  findLatestState,
  StateUpdateError,
} from "./state.ts";
import {
  DEFAULT_MAX_UPDATES,
  TASK_PROGRESS_VALUES,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  TASK_STATUS_STATE_TYPE,
  type TaskStatusState,
} from "./types.ts";
import {
  TASK_STATUS_INSTRUCTIONS,
  TASK_STATUS_SECTION,
  TOOL_NAME,
} from "./instructions.ts";

const STATUS_KEY = "task-status";

const updateTaskStatusSchema = Type.Object(
  {
    taskTransition: Type.Enum(TASK_TRANSITIONS, {
      description: "同一交付目标使用 continue；主要交付目标变化后使用 new",
    }),
    taskName: Type.Optional(Type.String({
      minLength: 1,
      description: "简洁、脱敏的主要任务名称；创建任务时必填，continue 已有任务时省略则沿用",
    })),
    status: Type.Enum(TASK_STATUSES, {
      description: "当前任务状态；completed 时 progressPercent 必须为 100",
    }),
    phase: Type.Optional(Type.String({
      minLength: 1,
      description: "当前工作阶段；创建任务时必填，continue 已有任务时省略则沿用",
    })),
    progressPercent: Type.Enum(TASK_PROGRESS_VALUES, {
      description: "整体进度估计：非 completed 为 0–90 的 10% 粒度；completed 必须为 100",
    }),
  },
  { additionalProperties: false },
);

type UpdateTaskStatusInput = Static<typeof updateTaskStatusSchema>;

interface TaskStatusUpdateDetails {
  changed: boolean;
  createdTask: boolean;
  statusText: string;
  updatesUsed: number;
  maxUpdatesPerTask: number;
  sessionNameWarning?: string;
}

export default function (pi: ExtensionAPI): void {
  let config = { maxUpdatesPerTask: DEFAULT_MAX_UPDATES };
  let currentState: TaskStatusState | undefined;
  let userGeneration = 0;
  let initialized = false;
  let disabledForSession = false;
  let restoreToolAfterReview = false;

  pi.registerTool({
    name: TOOL_NAME,
    label: "Task Status",
    description:
      "维护当前任务的名称、状态、阶段和整体进度估计；任务 ID 由扩展生成。",
    promptSnippet: "维护当前任务状态和进度估计",
    parameters: updateTaskStatusSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        await ensureInitialized(ctx);
        if (disabledForSession) throw new Error("任务效率复盘会话不维护任务状态");
        const input = params as UpdateTaskStatusInput;
        const result = applyStatusUpdate(input, currentState, {
          maxUpdatesPerTask: config.maxUpdatesPerTask,
          userGeneration,
          createTaskId: randomUUID,
        });
        const statusText = formatTaskStatus(result.state);
        if (result.changed) pi.appendEntry(TASK_STATUS_STATE_TYPE, result.state);
        currentState = result.state;
        setStatus(ctx, statusText);

        let sessionNameWarning: string | undefined;
        try {
          syncSessionName(pi, ctx.sessionManager, result.state.taskName);
        } catch (error) {
          sessionNameWarning = `会话名称更新失败，任务状态已保留：${error instanceof Error ? error.message : String(error)}`;
        }

        const details: TaskStatusUpdateDetails = {
          changed: result.changed,
          createdTask: result.createdTask,
          statusText,
          updatesUsed: result.state.updatesUsed,
          maxUpdatesPerTask: config.maxUpdatesPerTask,
          ...(sessionNameWarning ? { sessionNameWarning } : {}),
        };
        return {
          content: [
            {
              type: "text",
              text: `${result.changed ? "任务状态已更新" : "任务状态未变化"}：${statusText}${sessionNameWarning ? " · 警告：会话名称未同步" : ""}\n当前任务已使用 ${result.state.updatesUsed}/${config.maxUpdatesPerTask} 次更新。${sessionNameWarning ? `\n警告：${sessionNameWarning}` : ""}`,
            },
          ],
          details,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: getErrorMessage(error) }],
          details: { accepted: false },
          isError: true,
        };
      }
    },
    renderResult(result, options, theme, context) {
      const text = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text ?? "")
        .join("\n");
      const visibleLines = formatTaskStatusResult(
        text,
        options.expanded,
        context.isError,
        `${theme.fg("muted", "… ")}${keyHint("app.tools.expand", "展开详情")}`,
      );
      return new Text(
        visibleLines.map((line) => theme.fg("toolOutput", line)).join("\n"),
        0,
        0,
      );
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (disabledForSession || isTaskEfficiencyReviewSession(ctx.sessionManager.getBranch())) {
      delete event.systemPromptOptions.sections[TASK_STATUS_SECTION];
      enterReviewMode(ctx);
      return;
    }
    if (!event.systemPromptOptions.selectedTools?.includes(TOOL_NAME)) {
      delete event.systemPromptOptions.sections[TASK_STATUS_SECTION];
      return;
    }
    event.systemPromptOptions.sections[TASK_STATUS_SECTION] = TASK_STATUS_INSTRUCTIONS;
  });

  pi.on("session_start", async (_event, ctx) => {
    await initializeSession(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await initializeSession(ctx);
  });

  pi.on("message_start", async (event) => {
    if (!disabledForSession && event.message.role === "user") userGeneration += 1;
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearStatus(ctx);
  });

  async function ensureInitialized(ctx: ExtensionContext): Promise<void> {
    if (initialized) return;
    await initializeSession(ctx);
  }

  async function initializeSession(ctx: ExtensionContext): Promise<void> {
    const branch = ctx.sessionManager.getBranch();
    const reviewSession = isTaskEfficiencyReviewSession(branch);
    userGeneration = countUserMessages(branch);
    initialized = true;
    if (reviewSession) {
      enterReviewMode(ctx);
      return;
    }

    leaveReviewMode();
    config = await loadTaskStatusConfig();
    currentState = findLatestState(branch);
    refreshStatus(ctx);
  }

  function refreshStatus(ctx: ExtensionContext): void {
    setStatus(ctx, currentState ? formatTaskStatus(currentState) : formatFallbackStatus());
  }

  function setStatus(ctx: ExtensionContext, text: string | undefined): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(
      STATUS_KEY,
      text === undefined ? undefined : ctx.ui.theme.fg("dim", text),
    );
  }

  function clearStatus(ctx: ExtensionContext): void {
    setStatus(ctx, undefined);
  }

  function enterReviewMode(ctx: ExtensionContext): void {
    if (!disabledForSession) restoreToolAfterReview = pi.getActiveTools().includes(TOOL_NAME);
    disabledForSession = true;
    currentState = undefined;
    clearStatus(ctx);
    setToolEnabled(false);
  }

  function leaveReviewMode(): void {
    const shouldRestore = disabledForSession && restoreToolAfterReview;
    disabledForSession = false;
    restoreToolAfterReview = false;
    if (shouldRestore) setToolEnabled(true);
  }

  function setToolEnabled(enabled: boolean): void {
    const activeTools = pi.getActiveTools();
    const isActive = activeTools.includes(TOOL_NAME);
    if (enabled === isActive) return;
    pi.setActiveTools(enabled ? [...activeTools, TOOL_NAME] : activeTools.filter((name) => name !== TOOL_NAME));
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof StatusInputError || error instanceof StateUpdateError) {
    return `任务状态更新未接受：${error.message}`;
  }
  return `任务状态更新失败：${error instanceof Error ? error.message : String(error)}`;
}
