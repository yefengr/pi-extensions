#!/usr/bin/env node
/**
 * 真实 Pi TUI smoke。
 *
 * 在系统临时目录构造 112 个可列举的源会话 fixture，并启动与用户环境无关的
 * 独立 tmux server，在临时 PI_CODING_AGENT_DIR、offline、禁用自动资源发现
 * 的条件下显式加载本包 index.ts，通过真实按键与焦点协议验证
 * /task-efficiency 源会话选择器（regular/fullscreen 两种 --tui-mode，含窗口缩放），
 * 最后确认 smoke 没有写入任何 fixture 会话。
 *
 * 可用 TUI_SMOKE_MODE=regular|fullscreen 单独运行一种模式；不设置时两种都跑。
 * 前置：PATH 中的 tmux 与可执行的 Pi（入口可用 PI_BIN 覆盖，不承诺具体版本）。
 * 无联网与模型调用。
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { visibleWidth } from "@earendil-works/pi-tui";

import { REVIEW_NAME_PREFIX, SOURCE_ENTRY_TYPE } from "../src/extension/records.ts";
import { sessionListCapacity } from "../src/extension/session-selector.ts";
import { selectorCandidates, selectorPanelLines, selectorRectangle } from "./tui-smoke-screen.ts";

/** fixture 会话总数，选择器断言依赖该值。 */
const SESSION_COUNT = 112;
/** fixture 中唯一匹配搜索词的目标会话序号。 */
const TARGET_INDEX = 57;
const TARGET_NAME = "pi-lens 唯一目标会话";
const OTHER_NAME_PREFIX = "smoke 会话 ";
const TARGET_QUERY = "pi-lens";
const TMUX_SESSION_PREFIX = "task-efficiency-smoke";
const TERMINAL_WIDTH = 220;
const TERMINAL_HEIGHT = 55;
/** 较短终端高度：按有效覆盖层预算计算容量，应明显小于常规高度下的 10 行。 */
const SHORT_TERMINAL_HEIGHT = 16;
const NARROW_TERMINAL_WIDTH = 60;
const TUI_MODES = ["regular", "fullscreen"] as const;
const STARTUP_TIMEOUT_MS = 30_000;
const SCREEN_TIMEOUT_MS = 15_000;
const QUIT_TIMEOUT_MS = 10_000;
const TMUX_COMMAND_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 300;
const DIAGNOSTIC_LINE_LIMIT = 30;
const ANSI_PATTERN = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]/g;

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionPath = path.join(packageRoot, "index.ts");
const piBinary = process.env.PI_BIN?.trim() || "pi";

let tmuxSocket: string | undefined;
let tempRoot: string | undefined;
let tmuxSession: string | undefined;
let lastScreen = "";
let terminalColumns = TERMINAL_WIDTH;

type TuiMode = (typeof TUI_MODES)[number];

class SmokeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SmokeError";
  }
}

interface SmokeFixture {
  readonly agentDir: string;
  readonly workspace: string;
  readonly sessionDir: string;
}

type FixtureSnapshot = ReadonlyMap<string, string>;

/** 候选行数与翻页目标均取自组件容量函数（已含覆盖层预算），不在 smoke 里另写一套公式。 */
const FULL_VISIBLE_ROWS = sessionListCapacity(TERMINAL_HEIGHT);
const SHORT_VISIBLE_ROWS = sessionListCapacity(SHORT_TERMINAL_HEIGHT);
const SHORT_PAGE_TARGET = SHORT_VISIBLE_ROWS + 1;
const FULL_PAGE_TARGET = FULL_VISIBLE_ROWS + 1;
/** 只能以 fixture 会话名称开头的行才是候选行，避免覆盖层下方的历史内容被误判。 */
const CANDIDATE_LABEL_PREFIXES = [OTHER_NAME_PREFIX.trim(), TARGET_NAME] as const;
// 初始窗口从第 1 行开始；一次 PageDown 后窗口后移一行。
const EXPECTED_FIRST_WINDOW = windowOf(FULL_VISIBLE_ROWS, 1);
const EXPECTED_SHORT_WINDOW = windowOf(SHORT_VISIBLE_ROWS, 1);
const EXPECTED_SHORT_PAGED_WINDOW = windowOf(SHORT_VISIBLE_ROWS, 2);
const EXPECTED_RESTORED_WINDOW = windowOf(FULL_VISIBLE_ROWS, 2);
const EXPECTED_PAGED_WINDOW = windowOf(FULL_VISIBLE_ROWS, 2);

function windowOf(length: number, start: number): readonly number[] {
  return Array.from({ length }, (_value, index) => start + index);
}

async function main(): Promise<void> {
  try {
    await runSmoke();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

async function runSmoke(): Promise<void> {
  // macOS sun_path 上限约 104 字节：临时根与 socket 名都必须短，
  // 才能把 socket 放进 $TMUX_TMPDIR/tmux-<uid>/ 后仍可连接。
  tempRoot = await realpath(await mkdtemp(path.join(tmpdir(), "te-smoke-")));
  tmuxSocket = `te-${process.pid.toString(36)}-${Date.now().toString(36).slice(-6)}`;
  try {
    const modes = resolveRequestedModes();
    await assertPrerequisites(tempRoot);
    const fixture = await createFixture(tempRoot);
    const before = await snapshotSessionDir(fixture.sessionDir);
    for (const mode of modes) {
      await runSelectorScenario(fixture, before, mode);
    }
    console.log(
      `TUI smoke 通过：${SESSION_COUNT} 个隔离 fixture 会话，--tui-mode ${modes.join("/")} 下的启动/缩放/搜索/翻页/取消行为符合预期，fixture 未被写入。`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SmokeError(
      `${reason}\n--- 隔离 pane 摘要（最后 ${DIAGNOSTIC_LINE_LIMIT} 行非空输出） ---\n${captureDiagnostics()}`,
      { cause: error },
    );
  } finally {
    await cleanup();
  }
}

async function assertPrerequisites(prerequisiteRoot: string): Promise<void> {
  const tmuxVersion = spawnSync("tmux", ["-V"], { encoding: "utf8", timeout: TMUX_COMMAND_TIMEOUT_MS });
  if (tmuxVersion.error || tmuxVersion.status !== 0) {
    throw new SmokeError(`无法执行 tmux，请先安装并确保在 PATH 中${tmuxVersion.error ? `：${tmuxVersion.error.message}` : ""}`);
  }
  // Pi 前置检查同样只在隔离配置根内执行，不读取或写入用户真实配置。
  const isolatedAgentDir = path.join(prerequisiteRoot, "agent-prereq");
  await mkdir(isolatedAgentDir, { recursive: true });
  const piVersion = spawnSync(piBinary, ["--version"], {
    encoding: "utf8",
    timeout: TMUX_COMMAND_TIMEOUT_MS,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: isolatedAgentDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
    },
  });
  if (piVersion.error || piVersion.status !== 0) {
    throw new SmokeError(`无法执行 Pi（${piBinary}），可用 PI_BIN 指定入口${piVersion.error ? `：${piVersion.error.message}` : ""}`);
  }
}

/**
 * 复用 pi-coding-agent 的 SessionManager 生成 fixture。
 * SessionManager 只在 session 内出现 assistant 消息后才整体落盘，因此每条
 * fixture 都追加 user + assistant 占位消息；占位消息不触发任何模型调用。
 */
async function createFixture(root: string): Promise<SmokeFixture> {
  const agentDir = path.join(root, "agent");
  const workspace = path.join(root, "workspace");
  await mkdir(agentDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  type AppendInput = Parameters<ReturnType<typeof SessionManager.create>["appendMessage"]>[0];
  const userMessage = (index: number): AppendInput => ({
    role: "user",
    content: [{ type: "text", text: `smoke 用户消息 ${index}` }],
    timestamp: Date.now(),
  } as unknown as AppendInput);
  const assistantMessage = (index: number): AppendInput => ({
    role: "assistant",
    content: [{ type: "text", text: `smoke 助手回复 ${index}` }],
    api: "smoke-api",
    provider: "smoke-provider",
    model: "smoke-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as AppendInput);

  for (let index = 0; index < SESSION_COUNT; index += 1) {
    const manager = SessionManager.create(workspace);
    manager.appendSessionInfo(
      index === TARGET_INDEX ? TARGET_NAME : `${OTHER_NAME_PREFIX}${String(index).padStart(3, "0")}`,
    );
    manager.appendMessage(userMessage(index));
    manager.appendMessage(assistantMessage(index));
  }

  const sessionsRoot = path.join(agentDir, "sessions");
  const sessionDirs = (await readdir(sessionsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  if (sessionDirs.length !== 1) {
    throw new SmokeError(`隔离 agent 目录应仅有 1 个 session 目录，实际 ${sessionDirs.length}`);
  }
  const sessionDir = path.join(sessionsRoot, sessionDirs[0]!.name);

  const listed = await SessionManager.list(workspace);
  const targetCount = listed.filter((session) => session.name === TARGET_NAME).length;
  if (listed.length !== SESSION_COUNT || targetCount !== 1) {
    throw new SmokeError(`fixture 不完整：可列举会话 ${listed.length}/${SESSION_COUNT}，唯一目标 ${targetCount}`);
  }
  return { agentDir, workspace, sessionDir };
}

function resolveRequestedModes(): readonly TuiMode[] {
  const requested = process.env.TUI_SMOKE_MODE?.trim();
  if (requested === undefined || requested.length === 0) return TUI_MODES;
  if ((TUI_MODES as readonly string[]).includes(requested)) return [requested as TuiMode];
  throw new SmokeError(`TUI_SMOKE_MODE 仅支持 ${TUI_MODES.join("/")}，实际「${requested}」`);
}

async function runSelectorScenario(
  fixture: SmokeFixture,
  before: FixtureSnapshot,
  mode: TuiMode,
): Promise<void> {
  tmuxSession = `${TMUX_SESSION_PREFIX}-${mode}`;
  terminalColumns = TERMINAL_WIDTH;
  // 短屏断言必须真的比常规窗口更少行，否则“按预算收敛”会被覆盖层裁剪掩盖。
  if (SHORT_VISIBLE_ROWS < 1 || SHORT_VISIBLE_ROWS >= FULL_VISIBLE_ROWS) {
    throw new SmokeError(`短屏容量 ${SHORT_VISIBLE_ROWS} 未小于常规容量 ${FULL_VISIBLE_ROWS}`);
  }
  startPiTui(fixture, mode);
  await waitForScreen(
    `${mode}：Pi TUI 启动并加载显式扩展`,
    (screen) => screen.includes("task-efficiency") && screen.includes(fixture.workspace),
    STARTUP_TIMEOUT_MS,
  );

  sendLiteral("/task-efficiency");
  await sleep(500);
  sendKeys("Enter");
  const opened = await waitForScreen(
    "选择器打开并显示 位置 1/112",
    (screen) => screen.includes("位置 1/112") && screen.includes("选择要复盘的源会话"),
  );
  assertCandidateWindow(opened, "选择器初始窗口", "位置 1/112", EXPECTED_FIRST_WINDOW);
  assertActualKeyHints(opened);

  // 缩短高度：覆盖层预算 min(floor(rows*0.8), rows-2) 减 chrome，容量小于 10 行。
  resizeWindow(TERMINAL_WIDTH, SHORT_TERMINAL_HEIGHT);
  const shrunk = await waitForScreen(
    `短屏按预算显示 ${SHORT_VISIBLE_ROWS} 行候选`,
    (screen) => candidateRowNumbers(screen).length === SHORT_VISIBLE_ROWS && screen.includes("位置 1/112"),
  );
  assertCandidateWindow(shrunk, "短屏窗口", "位置 1/112", EXPECTED_SHORT_WINDOW);

  sendKeys("PageDown");
  const shortPaged = await waitForScreen(
    `短屏 PageDown 按实际行数移动到 ${SHORT_PAGE_TARGET}/112`,
    (screen) => screen.includes(`位置 ${SHORT_PAGE_TARGET}/112`),
  );
  assertCandidateWindow(
    shortPaged,
    "短屏 PageDown 窗口",
    `位置 ${SHORT_PAGE_TARGET}/112`,
    EXPECTED_SHORT_PAGED_WINDOW,
  );

  // 恢复高度：窗口围绕当前选中项重建，选中项仍可见。
  resizeWindow(TERMINAL_WIDTH, TERMINAL_HEIGHT);
  const restored = await waitForScreen(
    `恢复高度后重新显示 ${FULL_VISIBLE_ROWS} 行候选`,
    (screen) =>
      candidateRowNumbers(screen).length === FULL_VISIBLE_ROWS && screen.includes(`位置 ${SHORT_PAGE_TARGET}/112`),
  );
  assertCandidateWindow(restored, "恢复高度窗口", `位置 ${SHORT_PAGE_TARGET}/112`, EXPECTED_RESTORED_WINDOW);

  // 窄屏：候选行不得超出覆盖层宽度，且保留取消提示。
  resizeWindow(NARROW_TERMINAL_WIDTH, TERMINAL_HEIGHT);
  const narrow = await waitForScreen(
    `窄屏仍显示 ${FULL_VISIBLE_ROWS} 行候选`,
    (screen) => candidateRowNumbers(screen).length === FULL_VISIBLE_ROWS,
  );
  assertCandidateRowsWithinWidth(narrow, selectorRectangle(NARROW_TERMINAL_WIDTH).width, "窄屏");
  if (!narrow.includes("取消")) {
    throw new SmokeError("窄屏未保留取消提示");
  }

  resizeWindow(TERMINAL_WIDTH, TERMINAL_HEIGHT);
  await waitForScreen(
    "恢复宽度",
    (screen) =>
      candidateRowNumbers(screen).length === FULL_VISIBLE_ROWS && screen.includes(`位置 ${SHORT_PAGE_TARGET}/112`),
  );

  sendLiteral(TARGET_QUERY);
  const filtered = await waitForScreen("搜索筛选出唯一目标", (screen) => screen.includes("位置 1/1 · 筛选 1/112"));
  assertCandidateWindow(filtered, "搜索结果", "位置 1/1 · 筛选 1/112", [1]);
  if (!filtered.includes(TARGET_NAME)) {
    throw new SmokeError(`搜索结果未显示唯一目标会话「${TARGET_NAME}」`);
  }
  if (filtered.includes(`${OTHER_NAME_PREFIX}000`)) {
    throw new SmokeError("搜索结果仍显示其他 fixture 会话");
  }

  sendKeys("C-u");
  await waitForScreen(
    "清空搜索恢复完整窗口",
    (screen) => screen.includes("位置 1/112") && !screen.includes("筛选 "),
  );

  sendKeys("PageDown");
  const paged = await waitForScreen(
    `PageDown 移动选中项到 ${FULL_PAGE_TARGET}/112`,
    (screen) => screen.includes(`位置 ${FULL_PAGE_TARGET}/112`),
  );
  assertCandidateWindow(paged, "PageDown 窗口", `位置 ${FULL_PAGE_TARGET}/112`, EXPECTED_PAGED_WINDOW);

  sendKeys("Escape");
  // tmux 可能捕获到 redraw 的中间清屏帧；连续确认退出，避免把下一条命令送回搜索框。
  let closedScreens = 0;
  await waitForScreen(
    "Esc 关闭选择器并稳定恢复主界面",
    (screen) => {
      const closed = !screen.includes("选择要复盘的源会话") && !screen.includes("位置 ");
      closedScreens = closed ? closedScreens + 1 : 0;
      return closedScreens >= 3;
    },
  );

  sendLiteral("/quit");
  await sleep(500);
  sendKeys("Enter");
  await waitForTmuxExit();

  await verifyFixtureUnchanged(fixture.sessionDir, before);
}

function startPiTui(fixture: SmokeFixture, mode: TuiMode): void {
  const command = [
    "env",
    `PI_CODING_AGENT_DIR=${shellQuote(fixture.agentDir)}`,
    "PI_OFFLINE=1",
    shellQuote(piBinary),
    "--offline",
    "--no-extensions",
    "--extension",
    shellQuote(extensionPath),
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--tui-mode",
    mode,
  ].join(" ");
  tmuxOk([
    "new-session",
    "-d",
    "-s",
    requireTmuxSession(),
    "-x",
    String(TERMINAL_WIDTH),
    "-y",
    String(TERMINAL_HEIGHT),
    "-c",
    fixture.workspace,
    command,
  ]);
}

function resizeWindow(width: number, height: number): void {
  terminalColumns = width;
  tmuxOk(["resize-window", "-t", requireTmuxSession(), "-x", String(width), "-y", String(height)]);
}

async function verifyFixtureUnchanged(sessionDir: string, before: FixtureSnapshot): Promise<void> {
  const after = await snapshotSessionDir(sessionDir);
  const beforeNames = [...before.keys()];
  const afterNames = [...after.keys()];
  if (beforeNames.length !== afterNames.length || beforeNames.some((name, index) => name !== afterNames[index])) {
    throw new SmokeError(`fixture 文件集合发生变化：${beforeNames.length} -> ${afterNames.length}`);
  }
  for (const [name, digest] of before) {
    if (after.get(name) !== digest) {
      throw new SmokeError(`fixture 内容摘要变化：${name}`);
    }
    const content = await readFile(path.join(sessionDir, name), "utf8");
    if (content.includes(SOURCE_ENTRY_TYPE)) {
      throw new SmokeError(`fixture 出现 source marker：${name}`);
    }
    if (content.includes(REVIEW_NAME_PREFIX)) {
      throw new SmokeError(`fixture 出现 review 名称：${name}`);
    }
  }
}

async function snapshotSessionDir(sessionDir: string): Promise<FixtureSnapshot> {
  const files = (await readdir(sessionDir)).filter((file) => file.endsWith(".jsonl")).sort();
  const snapshot = new Map<string, string>();
  for (const file of files) {
    const content = await readFile(path.join(sessionDir, file), "utf8");
    snapshot.set(file, createHash("sha256").update(content).digest("hex"));
  }
  return snapshot;
}

function assertActualKeyHints(screen: string): void {
  for (const hint of ["Esc", "PgUp", "PgDn", "Enter"]) {
    if (!screen.includes(hint)) {
      throw new SmokeError(`操作提示未反映实际按键：缺少 ${hint}`);
    }
  }
}

function assertCandidateRowsWithinWidth(screen: string, maxWidth: number, label: string): void {
  for (const { line } of selectorCandidates(screen, terminalColumns, CANDIDATE_LABEL_PREFIXES)) {
    const width = visibleWidth(line);
    if (width > maxWidth) {
      throw new SmokeError(`${label}：候选行宽 ${width} 超过 ${maxWidth}`);
    }
  }
}

function requireTmuxSession(): string {
  if (tmuxSession === undefined) throw new SmokeError("tmux session 尚未创建");
  return tmuxSession;
}

function assertCandidateWindow(
  screen: string,
  label: string,
  status: string,
  expectedRows: readonly number[],
): void {
  if (!selectorPanelLines(screen, terminalColumns).join("\n").includes(status)) {
    throw new SmokeError(`${label}：屏幕缺少状态「${status}」`);
  }
  const candidates = selectorCandidates(screen, terminalColumns, CANDIDATE_LABEL_PREFIXES);
  const selected = candidates.filter((candidate) => candidate.selected).map((candidate) => candidate.index);
  const position = Number(/位置 (\d+)\//.exec(status)?.[1]);
  if (selected.length !== 1 || selected[0] !== position) {
    throw new SmokeError(`${label}：选中行应为 ${position}，实际 ${selected.join("、") || "无"}`);
  }
  const rows = candidates.map((candidate) => candidate.index);
  if (rows.length !== expectedRows.length || rows.some((row, index) => row !== expectedRows[index])) {
    throw new SmokeError(`${label}：候选行应为 ${expectedRows.join("、")}，实际 ${rows.join("、") || "无"}`);
  }
}

function candidateRowNumbers(screen: string): number[] {
  return selectorCandidates(screen, terminalColumns, CANDIDATE_LABEL_PREFIXES).map((candidate) => candidate.index);
}

async function waitForScreen(
  description: string,
  predicate: (screen: string) => boolean,
  timeoutMs = SCREEN_TIMEOUT_MS,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const screen = capturePane();
    lastScreen = screen;
    if (predicate(screen)) return screen;
    if (Date.now() >= deadline) {
      throw new SmokeError(`等待超时（${timeoutMs}ms）：${description}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function waitForTmuxExit(): Promise<void> {
  const deadline = Date.now() + QUIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = tmuxCommand(["has-session", "-t", requireTmuxSession()]);
    if (result === undefined) return;
    if (result.error) {
      throw new SmokeError(`tmux has-session 执行失败：${result.error.message}`, { cause: result.error });
    }
    // 退出码 1 表示 server/session 已结束，属于正常退出分支。
    if (result.status === 1) return;
    if (result.status !== 0) {
      throw new SmokeError(`tmux has-session 异常（退出码 ${result.status}）：${result.stderr.trim()}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new SmokeError(`Pi 未在 ${QUIT_TIMEOUT_MS}ms 内退出`);
}

async function cleanup(): Promise<void> {
  const result = tmuxCommand(["kill-server"]);
  if (result !== undefined && result.status !== 0 && result.status !== 1) {
    process.stderr.write(`清理警告：tmux kill-server 退出码 ${result.status}：${result.stderr.trim()}\n`);
  }
  const root = tempRoot;
  if (root === undefined) return;
  try {
    await rm(root, { recursive: true, force: true });
    if (existsSync(root)) {
      process.stderr.write(`清理警告：临时根仍未删除：${root}\n`);
    }
  } catch (error) {
    process.stderr.write(`清理警告：删除临时根失败：${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function captureDiagnostics(): string {
  const session = tmuxSession;
  const result = session === undefined ? undefined : tmuxCommand(["capture-pane", "-p", "-t", session]);
  const screen = result !== undefined && result.status === 0 ? result.stdout.replace(ANSI_PATTERN, "") : lastScreen;
  const lines = screen
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return "(无可用 pane 输出)";
  return lines.slice(-DIAGNOSTIC_LINE_LIMIT).join("\n");
}

function sendLiteral(text: string): void {
  tmuxOk(["send-keys", "-t", requireTmuxSession(), "-l", text]);
}

function sendKeys(...keys: readonly string[]): void {
  tmuxOk(["send-keys", "-t", requireTmuxSession(), ...keys]);
}

function capturePane(): string {
  return tmuxOk(["capture-pane", "-p", "-t", requireTmuxSession()]).replace(ANSI_PATTERN, "");
}

function tmuxOk(args: readonly string[]): string {
  const result = tmuxCommand(args);
  if (result === undefined) throw new SmokeError("tmux socket 尚未初始化");
  if (result.error) {
    throw new SmokeError(`tmux ${args[0]} 执行失败：${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new SmokeError(`tmux ${args.join(" ")} 失败（退出码 ${result.status}）：${result.stderr.trim()}`);
  }
  return result.stdout;
}

function tmuxCommand(args: readonly string[]): SpawnSyncReturns<string> | undefined {
  if (tmuxSocket === undefined) return undefined;
  // 让 tmux 把 socket 放进本次临时根（$TMUX_TMPDIR/tmux-<uid>/），
  // finally 递归删除临时根时一并清理，不污染用户默认 socket 目录。
  const env = tempRoot === undefined ? process.env : { ...process.env, TMUX_TMPDIR: tempRoot };
  return spawnSync("tmux", ["-L", tmuxSocket, "-f", "/dev/null", ...args], {
    encoding: "utf8",
    timeout: TMUX_COMMAND_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env,
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
