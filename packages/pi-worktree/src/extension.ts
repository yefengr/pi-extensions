import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  WORKTREE_MODES,
  WorktreeError,
  createWorktree,
  inspectCreateRequest,
  inspectRemoveWorktree,
  listWorktrees,
  removeWorktree,
  resolveMigrationTarget,
  type CommandRunner,
  type CreateWorktreeInput,
  type CreateWorktreeResult,
  type RemoveWorktreeInput,
  type RemoveWorktreeResult,
} from "./core.ts";
import { formatLocalTime, formatRemoveResult, formatWorktreeList } from "./worktree-format.ts";
import { selectWorktrees } from "./worktree-select.ts";
import { SessionMigrationError, migratePersistentSession } from "./session.ts";
import { createSessionHandoff, formatMigrationCommand, parseContinueTask } from "./session-handoff.ts";
import { registerWorktreeSwitch } from "./worktree-switch.ts";

const EXTENSION_NAME = "worktree:message";
const CREATE_COMMAND = "worktree:create";
const MIGRATE_COMMAND = "worktree:migrate";
const LIST_COMMAND = "worktree:list";
const REMOVE_COMMAND = "worktree:remove";
const CREATOR_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "create-worktree.sh");

const createSchema = Type.Object(
  {
    repoPath: Type.Optional(
      Type.String({ description: "Git 仓库或其 linked worktree 内的绝对路径；缺省使用当前会话工作目录" }),
    ),
    name: Type.String({ description: "Pi 工作树根目录（默认 ~/.pi/worktrees）下的目录名，小写字母、数字和单连字符，最长 40 字符" }),
    mode: StringEnum(WORKTREE_MODES),
    baseRef: Type.Optional(Type.String({ description: "new-branch 或 detached 模式的基准引用" })),
    branch: Type.Optional(Type.String({ description: "新建或已有本地分支名；detached 模式不得提供" })),
    setupHookApproved: Type.Optional(
      Type.Boolean({ description: "项目存在 .pi/worktree/setup.sh 时，确认已审查并批准执行" }),
    ),
  },
  { additionalProperties: false },
);

const listSchema = Type.Object(
  {
    repoPath: Type.Optional(
      Type.String({ description: "Git 仓库或其 linked worktree 内的绝对路径；缺省使用当前会话工作目录" }),
    ),
  },
  { additionalProperties: false },
);

const removeSchema = Type.Object(
  {
    repoPath: Type.Optional(
      Type.String({ description: "登记目标工作树的 Git 仓库路径；缺省使用当前会话工作目录" }),
    ),
    worktreePath: Type.String({ description: "要移除的 Pi 工作树绝对路径" }),
    confirmed: Type.Boolean({ description: "确认移除干净工作树；默认也安全删除关联本地分支" }),
    keepBranch: Type.Optional(Type.Boolean({ description: "设为 true 时仅移除工作树、保留关联分支；默认 false" })),
  },
  { additionalProperties: false },
);

interface MigrationCommandInput {
  repoPath: string;
  worktreePath: string;
}

interface CreateToolDetails extends CreateWorktreeResult {
  migrationStatus: "scheduled" | "unavailable";
  migrationCommand: string;
  migrationReason?: string;
}

export default function (pi: ExtensionAPI) {
  const runner: CommandRunner = {
    async run(command, args, options) {
      return pi.exec(command, args, options);
    },
  };
  const domainOptions = { runner, creatorPath: CREATOR_PATH };
  let mutationInProgress = false;
  const handoff = createSessionHandoff(pi);
  registerWorktreeSwitch(pi, runner,
    { forkFrom: (source, target) => SessionManager.forkFrom(source, target) },
    withMutationLock, (error) => reportCommandError(pi, error));

  pi.registerCommand(CREATE_COMMAND, {
    description: "创建并初始化由 Pi 管理的工作树，随后迁移持久会话",
    handler: async (args, ctx) => {
      try {
        const parsed = parseJsonObject(args);
        const repoPath = await resolveCommandRepoPath(parsed?.repoPath, ctx, runner);
        if (!repoPath) return;
        const input = parsed
          ? ({ ...(parsed as unknown as CreateWorktreeInput), repoPath } satisfies CreateWorktreeInput)
          : await collectCreateInput(ctx, domainOptions, repoPath);
        if (!input) return;

        await withMutationLock(async () => {
          const result = await createWorktree(input, domainOptions);
          await migrateCreatedWorktree(pi, ctx, result);
        });
      } catch (error) {
        reportCommandError(pi, error);
      }
    },
  });

  pi.registerCommand(MIGRATE_COMMAND, {
    description: "将当前持久 Pi 会话迁移到已登记的 Pi 管理工作树",
    handler: async (args, ctx) => {
      let continueTask = false;
      try {
        const parsed = parseJsonObject(args);
        continueTask = parseContinueTask(parsed?.continueTask);
        const repoPath = await resolveCommandRepoPath(parsed?.repoPath, ctx, runner);
        if (!repoPath) return;
        const worktreePath =
          parsed?.worktreePath === undefined || parsed.worktreePath === null
            ? await collectMigrationWorktree(ctx, runner, repoPath)
            : requireString(parsed.worktreePath, "worktreePath");
        if (!worktreePath) return;
        const input: MigrationCommandInput = { repoPath, worktreePath };

        await ctx.waitForIdle();
        if (continueTask) handoff.claim(ctx, input.repoPath, input.worktreePath);
        await withMutationLock(async () => {
          const target = await resolveMigrationTarget(input.repoPath, input.worktreePath, { runner });
          await migrateRegisteredWorktree(pi, ctx, target, continueTask);
        });
      } catch (error) {
        if (continueTask) handoff.clear();
        reportCommandError(pi, error);
      }
    },
  });

  pi.registerCommand(LIST_COMMAND, {
    description: "按创建时间倒序列出指定仓库中由 Pi 管理的工作树",
    handler: async (args, ctx) => {
      try {
        const parsed = parseJsonObject(args);
        const repoPath = await resolveCommandRepoPath(parsed?.repoPath, ctx, runner);
        if (!repoPath) return;

        const result = await listWorktrees(repoPath, runner);
        reportCommand(pi, formatWorktreeList(result.repoPath, result.worktrees));
      } catch (error) {
        reportCommandError(pi, error);
      }
    },
  });

  pi.registerCommand(REMOVE_COMMAND, {
    description: "交互多选并安全移除干净的非当前 Pi 管理工作树，成功后刷新列表；默认删除关联本地分支",
    handler: async (args, ctx) => {
      try {
        const parsed = parseJsonObject(args);
        const repoPath = await resolveCommandRepoPath(parsed?.repoPath, ctx, runner);
        if (!repoPath) return;
        if (!parsed) {
          await removeInteractively(ctx, repoPath);
          return;
        }
        const input: RemoveWorktreeInput = {
          repoPath,
          worktreePath: requireString(parsed.worktreePath, "worktreePath"),
          confirmed: parsed.confirmed === true,
          keepBranch: parseKeepBranch(parsed.keepBranch),
          currentCwd: ctx.cwd,
        };
        const result = await withMutationLock(() => removeWorktree(input, { runner }));
        reportCommand(pi, formatRemoveResult(result));
      } catch (error) {
        reportCommandError(pi, error);
      }
    },
  });

  pi.registerTool({
    name: "worktree_create",
    label: "Create Worktree",
    description:
      "创建由 Pi 管理的工作树（Git linked worktree），可能创建本地分支，并在 Git 管理目录写入 Pi 所有权标记。项目存在 .pi/worktree/setup.sh 时，调用前必须先读取并审查该脚本，再通过 setupHookApproved=true 明确批准；批准绑定当前内容标识。初始化成功后安排自动切换并结束本轮，切换成功后会继续原任务。必须单独调用本工具，不要与其他工具放在同一批次；自动切换完成前不得继续在旧目录调用工具。临时会话无法自动切换。",
    parameters: createSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "正在创建并初始化工作树..." }], details: undefined });
      const sourceSessionFile = ctx.sessionManager.getSessionFile();
      const details = await withMutationLock(async () => {
        const result = await createWorktree(
          { ...params, repoPath: params.repoPath?.trim() || ctx.cwd } as CreateWorktreeInput,
          {
            runner: signalRunner(runner, signal),
            creatorPath: CREATOR_PATH,
          },
        );
        const scheduled = !signal?.aborted && handoff.schedule(sourceSessionFile, result.repoPath, result.worktreePath);
        return createToolDetails(result, scheduled, signal?.aborted === true);
      });
      return {
        content: [{ type: "text", text: formatCreateToolResult(details) }],
        details,
        ...(details.migrationStatus === "scheduled" ? { terminate: true } : {}),
      };
    },
  });

  pi.registerTool({
    name: "worktree_list",
    label: "List Worktrees",
    description: "只读列出指定仓库中由 Pi 管理的工作树（按创建时间倒序）；其他工具创建或缺少有效所有权标记的工作树不会出现。",
    parameters: listSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await listWorktrees(
        params.repoPath?.trim() || ctx.cwd,
        signalRunner(runner, signal),
      );
      return {
        content: [{ type: "text", text: formatWorktreeList(result.repoPath, result.worktrees) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "worktree_remove",
    label: "Remove Worktree",
    description:
      "仅在 confirmed=true 时非强制移除指定仓库中由 Pi 管理且干净的工作树；默认安全删除关联本地分支，keepBranch=true 时只移除工作树。拒绝当前会话工作树，未合并分支拒绝移除。",
    parameters: removeSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await withMutationLock(() =>
        removeWorktree(
          {
            repoPath: params.repoPath?.trim() || ctx.cwd,
            worktreePath: params.worktreePath,
            currentCwd: ctx.cwd,
            confirmed: params.confirmed,
            keepBranch: params.keepBranch,
          },
          { runner: signalRunner(runner, signal) },
        ),
      );
      return {
        content: [{ type: "text", text: formatRemoveResult(result) }],
        details: result,
      };
    },
  });

  async function removeInteractively(ctx: ExtensionCommandContext, repoPath: string): Promise<void> {
    requireInteractiveCommand(ctx);
    let completedAny = false;
    for (;;) {
      const candidates = (await listWorktrees(repoPath, runner)).worktrees;
      if (candidates.length === 0) {
        if (!completedAny) reportCommand(pi, "指定仓库没有可移除的 Pi 工作树");
        return;
      }
      const selected = await selectWorktrees(ctx, candidates);
      if (!selected?.length) return;
      const scope = selected.some((record) => record.branch)
        ? await ctx.ui.select("移除范围", [
            "移除工作树和本地分支（默认）",
            "仅移除工作树（保留本地分支）",
          ])
        : "移除工作树和本地分支（默认）";
      if (!scope) return;
      const keepBranch = scope.startsWith("仅移除");
      const inputs = selected.map((record): RemoveWorktreeInput => ({
        repoPath, worktreePath: record.path, currentCwd: ctx.cwd, confirmed: true, keepBranch,
      }));

      let inspected: Awaited<ReturnType<typeof inspectRemoveWorktree>>[];
      try {
        inspected = [];
        for (const input of inputs) inspected.push(await inspectRemoveWorktree(input, { runner }));
      } catch (error) {
        reportCommandError(pi, error);
        continue;
      }
      const confirmed = await ctx.ui.confirm(
        `确认移除 ${inspected.length} 个工作树`,
        inspected.map((item) => [
          item.worktreePath,
          `分支：${!item.branch ? "无（detached HEAD）" : keepBranch ? `保留 ${item.branch}` : `安全删除 ${item.branch}`}`,
          `创建：${formatLocalTime(item.createdAt)} | 最近提交：${formatLocalTime(item.lastCommitAt)}`,
        ].join("\n")).join("\n\n"),
      );
      if (!confirmed) continue;

      const results: RemoveWorktreeResult[] = [];
      let failure: { error: unknown } | undefined;
      await withMutationLock(async () => {
        for (let index = 0; index < inputs.length; index++) {
          try {
            results.push(await removeWorktree(inputs[index], { runner }, inspected[index]));
          } catch (error) {
            failure = { error };
            break;
          }
        }
      });
      const removalStatus = failure?.error instanceof WorktreeError
        ? failure.error.removalStatus
        : "not-started";
      const removedCount = results.length + (removalStatus === "removed" ? 1 : 0);
      completedAny ||= removedCount > 0;
      reportCommand(pi, [
        `本轮已确认移除 ${removedCount}/${inputs.length} 个工作树`,
        ...results.map(formatRemoveResult),
        ...(removalStatus === "unverified" ? ["另有 1 个工作树移除命令已执行，结果未确认。"] : []),
        ...(failure ? ["批量操作已停止；其余目标未处理。"] : []),
      ].join("\n\n"));
      if (failure) {
        reportCommandError(pi, failure.error);
        return;
      }
    }
  }

  async function withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    handoff.assertAvailable();
    if (mutationInProgress) {
      throw new Error("已有工作树副作用操作或会话迁移正在进行，请等待完成后重试");
    }
    mutationInProgress = true;
    try {
      return await operation();
    } finally {
      mutationInProgress = false;
    }
  }
}

async function collectCreateInput(
  ctx: ExtensionCommandContext,
  domainOptions: Parameters<typeof inspectCreateRequest>[1],
  repoPath: string,
): Promise<CreateWorktreeInput | undefined> {
  requireInteractiveCommand(ctx);
  const name = await collectRequiredInput(ctx, "工作树名称", "project-task-name");
  if (!name) return undefined;
  const mode = await ctx.ui.select("工作树模式", [...WORKTREE_MODES]) as CreateWorktreeInput["mode"] | undefined;
  if (!mode) return undefined;

  let baseRef: string | undefined;
  let branch: string | undefined;
  if (mode === "new-branch") {
    baseRef = await collectRequiredInput(ctx, "基准引用", "main");
    branch = await collectRequiredInput(ctx, "新分支名", "feat/YYMMDD-topic");
  } else if (mode === "existing-branch") {
    branch = await collectRequiredInput(ctx, "已有本地分支名", "feat/YYMMDD-topic");
  } else {
    baseRef = await collectRequiredInput(ctx, "基准引用", "HEAD");
  }
  if ((mode !== "existing-branch" && !baseRef) || (mode !== "detached" && !branch)) return undefined;

  const input: CreateWorktreeInput = { repoPath, name, mode, baseRef, branch };
  const inspected = await inspectCreateRequest(input, domainOptions);
  if (inspected.setupHookPath) {
    const approved = await ctx.ui.confirm(
      "批准项目工作树钩子",
      [
        `将执行：${inspected.setupHookPath}`,
        `真实路径：${inspected.setupHookResolvedPath}`,
        `内容标识：${inspected.setupHookBlobId}`,
      ].join("\n"),
    );
    if (!approved) return undefined;
    input.setupHookApproved = true;
  }
  return input;
}

function createToolDetails(result: CreateWorktreeResult, scheduled: boolean, aborted: boolean): CreateToolDetails {
  return {
    ...result,
    migrationStatus: scheduled ? "scheduled" : "unavailable",
    migrationCommand: formatMigrationCommand(result.repoPath, result.worktreePath),
    ...(!scheduled ? { migrationReason: aborted ? "本轮已取消，未安排自动切换" : "当前会话未持久化，无法自动切换" } : {}),
  };
}

async function migrateCreatedWorktree(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  result: CreateWorktreeResult,
): Promise<void> {
  const migration = await migratePersistentSession(
    ctx,
    result.worktreePath,
    { forkFrom: (source, target) => SessionManager.forkFrom(source, target) },
    [
      `Pi 会话已迁移到 ${result.worktreePath}`,
      `模式：${result.mode}`,
      `分支：${result.branch ?? "detached HEAD"}`,
      `初始化：${result.setupHook.status}`,
    ].join("\n"),
  );
  if (migration.status === "unavailable") {
    reportCommand(
      pi,
      `${formatCreateResult(result)}\n当前会话未持久化，无法自动迁移；目标工作树仍可使用。`,
    );
  }
}

async function migrateRegisteredWorktree(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  target: Awaited<ReturnType<typeof resolveMigrationTarget>>,
  continueTask = false,
): Promise<void> {
  const migration = await migratePersistentSession(
    ctx,
    target.worktreePath,
    { forkFrom: (source, targetCwd) => SessionManager.forkFrom(source, targetCwd) },
    [
      `Pi 会话已迁移到 ${target.worktreePath}`,
      `仓库：${target.repoPath}`,
      `分支：${target.record.branch ?? "detached HEAD"}`,
    ].join("\n"),
    continueTask,
  );
  if (migration.status === "unavailable") {
    reportCommand(
      pi,
      `当前会话未持久化，无法迁移到 ${target.worktreePath}；目标工作树仍可使用。`,
    );
  }
}

function parseJsonObject(args: string): Record<string, unknown> | undefined {
  const trimmed = args.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("命令参数必须是单个 JSON 对象；TUI 模式可不传参数进入交互流程");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("命令参数必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

function requireInteractiveCommand(ctx: ExtensionCommandContext): void {
  if (ctx.mode !== "tui") {
    throw new Error("当前模式不能交互收集参数，请向命令传入单个 JSON 对象");
  }
}

async function collectRequiredInput(
  ctx: ExtensionCommandContext,
  title: string,
  placeholder: string,
): Promise<string | undefined> {
  requireInteractiveCommand(ctx);
  const value = await ctx.ui.input(title, placeholder);
  const normalized = value?.trim();
  return normalized || undefined;
}

function parseKeepBranch(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error("keepBranch 必须是布尔值");
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 必须是非空字符串`);
  return value.trim();
}

/**
 * 解析命令的 repoPath：显式参数优先，缺省回落到当前会话工作目录。
 * 候选路径不在 Git 仓库内时：显式给出则交给 core 报具体错误；未给出且 TUI 下回退询问。
 */
async function resolveCommandRepoPath(
  explicit: unknown,
  ctx: ExtensionCommandContext,
  runner: CommandRunner,
): Promise<string | undefined> {
  const given = normalizeExplicitRepoPath(explicit);
  const candidate = given ?? ctx.cwd;
  if (await isInsideGitWorktree(candidate, runner)) return candidate;
  if (given || ctx.mode !== "tui") return candidate;
  return collectRequiredInput(ctx, "Git 仓库路径（当前目录不在 Git 仓库内）", candidate);
}

function normalizeExplicitRepoPath(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("repoPath 必须是非空字符串");
  }
  return value.trim();
}

async function isInsideGitWorktree(dir: string, runner: CommandRunner): Promise<boolean> {
  try {
    const result = await runner.run("git", [
      "-C",
      dir,
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    return result.code === 0 && result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** 交互选择要迁移到的 Pi 工作树：候选直接来自 listWorktrees 的所有权过滤结果。 */
async function collectMigrationWorktree(
  ctx: ExtensionCommandContext,
  runner: CommandRunner,
  repoPath: string,
): Promise<string | undefined> {
  requireInteractiveCommand(ctx);
  const candidates = (await listWorktrees(repoPath, runner)).worktrees;
  if (candidates.length === 0) {
    throw new Error("该仓库没有可迁移的 Pi 工作树");
  }
  return ctx.ui.select(
    "选择要迁移到的工作树",
    candidates.map((record) => record.path),
  );
}

function signalRunner(runner: CommandRunner, signal: AbortSignal | undefined): CommandRunner {
  return {
    run: (command, args, options) => runner.run(command, args, { ...options, signal }),
  };
}

function formatCreateResult(result: CreateWorktreeResult): string {
  return [
    `工作树：${result.worktreePath}`,
    `仓库：${result.repoPath}`,
    `模式：${result.mode}`,
    `分支：${result.branch ?? "detached HEAD"}`,
    `初始化：${result.setupHook.status}`,
  ].join("\n");
}

function formatCreateToolResult(result: CreateToolDetails): string {
  return [
    formatCreateResult(result),
    result.migrationStatus === "scheduled"
      ? "Pi 会话尚未切换；已安排在本轮结束后自动切换，并在新工作空间继续原任务。请勿继续在旧目录操作。"
      : `${result.migrationReason}；目标工作树已保留，原会话未切换。`,
    `失败恢复命令：${result.migrationCommand}`,
  ].join("\n");
}

function reportCommand(pi: ExtensionAPI, text: string): void {
  pi.sendMessage({ customType: EXTENSION_NAME, content: text, display: true });
}

function reportCommandError(pi: ExtensionAPI, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const detail =
    error instanceof WorktreeError
      ? `阶段：${error.stage}${error.worktreePath ? `\n工作树：${error.worktreePath}` : ""}`
      : error instanceof SessionMigrationError
        ? `目标：${error.targetCwd}${error.migratedSessionFile ? `\n迁移会话：${error.migratedSessionFile}` : ""}`
        : "";
  try {
    reportCommand(pi, `错误：${message}${detail ? `\n${detail}` : ""}`);
  } catch {
    // 会话已替换时旧扩展实例不可再发送消息；replacement context 已负责显示错误。
  }
}
