#!/usr/bin/env node
/**
 * 真实 Pi TUI smoke。
 *
 * 在系统临时目录构造 112 个可列举的源会话 fixture，并启动与用户环境无关的
 * 独立 tmux server，在临时 PI_CODING_AGENT_DIR、offline、禁用自动资源发现
 * 的条件下显式加载本包 index.ts，通过真实按键与焦点协议验证
 * /efficiency 源会话选择器，最后确认 smoke 没有写入任何 fixture 会话。
 *
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

import { REVIEW_NAME_PREFIX, SOURCE_ENTRY_TYPE } from "../extension/records.ts";

/** fixture 会话总数，选择器断言依赖该值。 */
const SESSION_COUNT = 112;
/** fixture 中唯一匹配搜索词的目标会话序号。 */
const TARGET_INDEX = 57;
const TARGET_NAME = "pi-lens 唯一目标会话";
const OTHER_NAME_PREFIX = "smoke 会话 ";
const TARGET_QUERY = "pi-lens";
const TMUX_SESSION_NAME = "efficiency-smoke";
const TERMINAL_WIDTH = 220;
const TERMINAL_HEIGHT = 55;
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
let lastScreen = "";

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

// 选择器每页固定 10 行；PageDown 后窗口整体后移至第 2..11 行。
const EXPECTED_FIRST_WINDOW = Array.from({ length: 10 }, (_value, index) => index + 1);
const EXPECTED_PAGED_WINDOW = Array.from({ length: 10 }, (_value, index) => index + 2);

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
    await assertPrerequisites(tempRoot);
    const fixture = await createFixture(tempRoot);
    const before = await snapshotSessionDir(fixture.sessionDir);
    await runSelectorScenario(fixture, before);
    console.log(
      `TUI smoke 通过：${SESSION_COUNT} 个隔离 fixture 会话，选择器窗口/搜索/翻页/取消行为符合预期，fixture 未被写入。`,
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

async function runSelectorScenario(fixture: SmokeFixture, before: FixtureSnapshot): Promise<void> {
  startPiTui(fixture);
  await waitForScreen(
    "Pi TUI 启动并加载显式扩展",
    (screen) => screen.includes("efficiency") && screen.includes(fixture.workspace),
    STARTUP_TIMEOUT_MS,
  );

  sendLiteral("/efficiency");
  await sleep(500);
  sendKeys("Enter");
  const opened = await waitForScreen(
    "选择器打开并显示 位置 1/112",
    (screen) => screen.includes("位置 1/112") && screen.includes("选择要复盘的源会话"),
  );
  assertCandidateWindow(opened, "选择器初始窗口", "位置 1/112", EXPECTED_FIRST_WINDOW);

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
  const paged = await waitForScreen("PageDown 移动选中项到 11/112", (screen) => screen.includes("位置 11/112"));
  assertCandidateWindow(paged, "PageDown 窗口", "位置 11/112", EXPECTED_PAGED_WINDOW);

  sendKeys("Escape");
  await waitForScreen(
    "Esc 关闭选择器",
    (screen) => !screen.includes("选择要复盘的源会话") && !screen.includes("位置 "),
  );

  sendLiteral("/quit");
  await sleep(500);
  sendKeys("Enter");
  await waitForTmuxExit();

  await verifyFixtureUnchanged(fixture.sessionDir, before);
}

function startPiTui(fixture: SmokeFixture): void {
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
  ].join(" ");
  tmuxOk([
    "new-session",
    "-d",
    "-s",
    TMUX_SESSION_NAME,
    "-x",
    String(TERMINAL_WIDTH),
    "-y",
    String(TERMINAL_HEIGHT),
    "-c",
    fixture.workspace,
    command,
  ]);
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

function assertCandidateWindow(
  screen: string,
  label: string,
  status: string,
  expectedRows: readonly number[],
): void {
  if (!screen.includes(status)) {
    throw new SmokeError(`${label}：屏幕缺少状态「${status}」`);
  }
  const rows = candidateRowNumbers(screen).sort((left, right) => left - right);
  if (rows.length !== expectedRows.length || rows.some((row, index) => row !== expectedRows[index])) {
    throw new SmokeError(`${label}：候选行应为 ${expectedRows.join("、")}，实际 ${rows.join("、") || "无"}`);
  }
}

function candidateRowNumbers(screen: string): number[] {
  return screen
    .split("\n")
    .map((line) => line.trim())
    .flatMap((line) => {
      const match = /^(?:>\s+)?(\d+)\.\s/.exec(line);
      return match ? [Number(match[1])] : [];
    });
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
    const result = tmuxCommand(["has-session", "-t", TMUX_SESSION_NAME]);
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
  const result = tmuxCommand(["capture-pane", "-p", "-t", TMUX_SESSION_NAME]);
  const screen = result !== undefined && result.status === 0 ? result.stdout.replace(ANSI_PATTERN, "") : lastScreen;
  const lines = screen
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return "(无可用 pane 输出)";
  return lines.slice(-DIAGNOSTIC_LINE_LIMIT).join("\n");
}

function sendLiteral(text: string): void {
  tmuxOk(["send-keys", "-t", TMUX_SESSION_NAME, "-l", text]);
}

function sendKeys(...keys: readonly string[]): void {
  tmuxOk(["send-keys", "-t", TMUX_SESSION_NAME, ...keys]);
}

function capturePane(): string {
  return tmuxOk(["capture-pane", "-p", "-t", TMUX_SESSION_NAME]).replace(ANSI_PATTERN, "");
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
