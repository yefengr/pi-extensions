import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MonitorEngine } from "../src/engine.ts";
import { executeCheck } from "../src/executor.ts";
import { MonitorLogger, projectLogFile, resolveProjectRoot } from "../src/logging.ts";
import { definition, eventually } from "./helpers.ts";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "monitor-log-"));
}

function entries(file: string): Array<Record<string, any>> {
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("info 默认写入事件摘要，debug 条目被过滤", async () => {
  const cwd = tempDir();
  const notices: string[] = [];
  const logger = new MonitorLogger((message) => notices.push(message));
  const task = definition({ cwd, id: "task-info-1", name: "等待构建", logLevel: "info" });
  logger.write(task, { action: "check", accepted: 1, events: [{ id: "build-1", summary: "构建完成" }] });
  logger.write(task, { action: "check", level: "debug", commands: ["--token=not-logged"] });
  await logger.flush();
  const file = projectLogFile(task);
  assert.equal(file, path.join(cwd, ".pi", "logs", "monitor", "等待构建-task-inf.jsonl"));
  const written = entries(file);
  assert.equal(written.length, 1);
  assert.equal(written[0].action, "check");
  assert.equal(written[0].sessionId, "owner-1");
  assert.deepEqual(written[0].events, [{ id: "build-1", summary: "构建完成" }]);
  assert.doesNotMatch(readFileSync(file, "utf8"), /not-logged/);
  assert.equal(notices.length, 0);
});

test("off 不创建日志，debug 记录调试条目", async () => {
  const offDir = tempDir();
  const silent = new MonitorLogger(() => {});
  const offTask = definition({ cwd: offDir, id: "task-off-1", name: "关闭", logLevel: "off" });
  silent.write(offTask, { action: "check" });
  await silent.flush();
  assert.equal(existsSync(path.join(offDir, ".pi")), false);

  const debugDir = tempDir();
  const logger = new MonitorLogger(() => {});
  const debugTask = definition({ cwd: debugDir, id: "task-debug-1", name: "调试", logLevel: "debug" });
  logger.write(debugTask, { action: "check" });
  logger.write(debugTask, { action: "check", level: "debug", commands: ["node", "check.mjs"] });
  await logger.flush();
  const written = entries(projectLogFile(debugTask));
  assert.equal(written.length, 2);
  assert.deepEqual(written[1].commands, ["node", "check.mjs"]);
});

test("项目根解析支持 .git 目录与 worktree 占位文件", () => {
  const root = tempDir();
  mkdirSync(path.join(root, ".git"));
  const nested = path.join(root, "packages", "app");
  mkdirSync(nested, { recursive: true });
  assert.equal(resolveProjectRoot(nested), root);

  const worktree = tempDir();
  writeFileSync(path.join(worktree, ".git"), "gitdir: /tmp/nonexistent\n");
  assert.equal(resolveProjectRoot(worktree), worktree);

  const loose = tempDir();
  assert.equal(resolveProjectRoot(path.join(loose, "sub")), path.join(loose, "sub"));
});

test("日志目录自动忽略，避免污染项目 git status", async () => {
  const cwd = tempDir();
  const logger = new MonitorLogger(() => {});
  const task = definition({ cwd, id: "task-ignore-1", name: "忽略", logLevel: "info" });
  logger.write(task, { action: "start" });
  await logger.flush();
  assert.equal(readFileSync(path.join(cwd, ".pi", "logs", ".gitignore"), "utf8"), "*\n");
});

test("日志目录被外部清理后自动重建一次", async () => {
  const cwd = tempDir();
  const notices: string[] = [];
  const logger = new MonitorLogger((message) => notices.push(message));
  const task = definition({ cwd, id: "task-recreate-1", name: "重建", logLevel: "info" });
  logger.write(task, { action: "check", index: 1 });
  await logger.flush();
  rmSync(path.join(cwd, ".pi"), { recursive: true, force: true });
  logger.write(task, { action: "check", index: 2 });
  await logger.flush();
  assert.deepEqual(entries(projectLogFile(task)).map((entry) => entry.index), [2]);
  assert.equal(notices.length, 0);
  assert.equal(readFileSync(path.join(cwd, ".pi", "logs", ".gitignore"), "utf8"), "*\n");
});

test("超过单文件上限时轮转并保留有界备份", async () => {
  const cwd = tempDir();
  const logger = new MonitorLogger(() => {}, { maxBytes: 400, maxBackups: 2 });
  const task = definition({ cwd, id: "task-rotate-1", name: "轮转", logLevel: "info" });
  const padding = "x".repeat(120);
  for (let index = 0; index < 12; index++) logger.write(task, { action: "check", index, padding });
  await logger.flush();
  const file = projectLogFile(task);
  assert.ok(statSync(file).size <= 400);
  assert.ok(existsSync(`${file}.1`));
  assert.equal(existsSync(`${file}.3`), false);
  const newest = entries(file);
  assert.equal(newest.at(-1)?.index, 11);
});

test("写入失败只提醒一次，不影响后续调用", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root 用户不受目录权限限制");
  const cwd = tempDir();
  const notices: string[] = [];
  const logger = new MonitorLogger((message) => notices.push(message));
  const task = definition({ cwd, id: "task-deny-1", name: "拒绝", logLevel: "info" });
  const blockedRoot = path.join(cwd, "readonly");
  mkdirSync(blockedRoot);
  task.cwd = blockedRoot;
  chmodSync(blockedRoot, 0o500);
  t.after(() => chmodSync(blockedRoot, 0o700));
  logger.write(task, { action: "check" });
  await logger.flush();
  logger.write(task, { action: "check" });
  await logger.flush();
  assert.equal(notices.length, 1);
  assert.match(notices[0], /日志写入失败/);
});

test("引擎检查结果、摘要与完成状态写入项目日志", async (t) => {
  const cwd = tempDir();
  const logger = new MonitorLogger(() => {});
  const task = definition({ cwd, id: "task-engine-1", name: "集成", mode: "once", intervalMs: 5, logLevel: "info" });
  const engine = new MonitorEngine({
    check: async () => ({ state: "ok", events: [{ id: "e1", summary: "队列已清空" }] }),
    save: () => {}, changed: () => {}, log: (record, entry) => logger.write(record, entry),
  });
  t.after(() => engine.dispose());
  engine.add(task);
  await eventually(() => engine.get(task.id)?.status === "completed");
  await logger.flush();
  const written = entries(projectLogFile(task));
  const check = written.find((entry) => entry.action === "check");
  assert.equal(check?.state, "ok");
  assert.deepEqual(check?.events, [{ id: "e1", summary: "队列已清空" }]);
  assert.ok(written.some((entry) => entry.action === "complete"));
  // 检查结果必须先于它触发的状态迁移与投递出现。
  assert.ok(written.findIndex((entry) => entry.action === "check") < written.findIndex((entry) => entry.action === "complete"));
});

test("真实检查命令经执行器写入日志", async (t) => {
  const cwd = tempDir();
  const logger = new MonitorLogger(() => {});
  const task = definition({
    cwd, id: "task-exec-1", name: "执行器", mode: "once", intervalMs: 5, timeoutMs: 5_000,
    args: ["-e", `console.log(JSON.stringify({ state: "ok", events: [{ id: "real-1", summary: "真实检查完成" }] }))`],
  });
  const engine = new MonitorEngine({
    check: executeCheck, save: () => {}, changed: () => {}, log: (record, entry) => logger.write(record, entry),
  });
  t.after(() => engine.dispose());
  engine.add(task);
  await eventually(() => engine.get(task.id)?.status === "completed", 5_000);
  await logger.flush();
  const written = entries(projectLogFile(task));
  const check = written.find((entry) => entry.action === "check");
  assert.equal(check?.state, "ok");
  assert.deepEqual(check?.events, [{ id: "real-1", summary: "真实检查完成" }]);
});

test("日志失败不改变监听状态", async (t) => {
  const cwd = tempDir();
  const task = definition({ cwd, id: "task-throw-1", name: "抛错", mode: "once", intervalMs: 5 });
  const engine = new MonitorEngine({
    check: async () => ({ state: "ok", events: [{ id: "e1", summary: "完成" }] }),
    save: () => {}, changed: () => {},
    log: () => { throw new Error("日志故障"); },
  });
  t.after(() => engine.dispose());
  engine.add(task);
  await eventually(() => engine.get(task.id)?.status === "completed");
  assert.equal(engine.get(task.id)?.pending.length, 1);
});
