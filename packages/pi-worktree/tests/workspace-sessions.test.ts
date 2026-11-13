import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { discoverWorkspaceSessions, preflightWorkspaceSession, restoreWorkspaceSession, workspaceSessionLabels,
  WorkspaceRestoreError, type WorkspaceSession } from "../src/workspace-sessions.ts";

const id = "33333333-3333-7333-8333-333333333333";
const timestamp = "2026-01-01T00:00:00.000Z";
function history(cwd: string, sessionId = id): string {
  return `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd, timestamp })}\n${JSON.stringify({
    type: "message", id: "message", parentId: null, timestamp,
    message: { role: "user", content: "original history", timestamp: Date.parse(timestamp) },
  })}\n`;
}

async function fixture(run: (session: WorkspaceSession, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-sessions-"));
  try {
    const cwd = await realpath(root);
    const file = path.join(cwd, "history.jsonl");
    await writeFile(file, history(cwd));
    await run({ path: file, id, cwd, firstMessage: "original history", modified: new Date(timestamp) }, cwd);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("原生恢复保留目标原 ID、路径与内容，不访问空白源会话", async () => fixture(async (session, root) => {
  const before = await readFile(session.path, "utf8");
  let switches = 0;
  const notices: string[] = [];
  await restoreWorkspaceSession({ switchSession: async (file, options) => {
    switches++;
    assert.equal(file, session.path);
    const reopened = SessionManager.open(file);
    assert.equal(reopened.getSessionId(), session.id);
    assert.equal(reopened.getHeader()?.parentSession, undefined);
    assert.equal(reopened.getEntries().length, 1);
    await options!.withSession!({ cwd: root, sessionManager: reopened,
      ui: { notify: (message: string) => notices.push(message) },
      sendMessage: () => { throw new Error("不能触发模型"); },
    } as never);
    return { cancelled: false };
  } }, session, root);
  assert.equal(switches, 1);
  assert.deepEqual(notices, [`Pi 会话已恢复到 ${root}`]);
  assert.equal(await readFile(session.path, "utf8"), before);
}));

test("切换前重验被删除、损坏、空白、目录、身份或 cwd 已改变的选中历史", async () => {
  for (const scenario of ["deleted", "corrupt", "empty", "directory", "id", "cwd"] as const) {
    await fixture(async (session, root) => {
      if (scenario === "deleted" || scenario === "directory") await rm(session.path);
      if (scenario === "directory") await mkdir(session.path);
      if (scenario === "corrupt") await writeFile(session.path, "not json\n");
      if (scenario === "empty") await writeFile(session.path, "");
      if (scenario === "id") await writeFile(session.path, history(root, "44444444-4444-7444-8444-444444444444"));
      if (scenario === "cwd") {
        await mkdir(path.join(root, "nested"));
        await writeFile(session.path, history(path.join(root, "nested")));
      }
      await assert.rejects(restoreWorkspaceSession({ switchSession: async () => { throw new Error("unexpected switch"); } }, session, root),
        (error: Error) => !error.message.includes("unexpected switch"), scenario);
    });
  }
});

test("会话头读取兼容空行、CRLF、跨块中文和无末尾换行", async () => fixture(async (session, root) => {
  const prefix = '{"type":"session","padding":"';
  const padding = "x".repeat(64 * 1024 - Buffer.byteLength(prefix) - 1);
  const largeHeader = `${prefix}${padding}中",${JSON.stringify({ id, cwd: root }).slice(1)}`;
  for (const content of [
    `\n \r\n${JSON.stringify({ type: "session", id, cwd: root })}\r\nnot a JSON entry\n`,
    largeHeader,
    `${largeHeader}\r\nnot a JSON entry\n`,
  ]) {
    await writeFile(session.path, content);
    await preflightWorkspaceSession(session, root);
  }
}));

test("取消恢复无成功提示；缺少 replacement 验证明确失败", async () => fixture(async (session, root) => {
  await restoreWorkspaceSession({ switchSession: async () => ({ cancelled: true }) }, session, root);
  await assert.rejects(restoreWorkspaceSession({ switchSession: async () => ({ cancelled: false }) }, session, root),
    (error: unknown) => error instanceof WorkspaceRestoreError && error.replaced && /未能验证/.test(error.message));
}));

test("replacement cwd、ID 与文件路径严格验证，错误仅由新 UI 通知", async () => {
  for (const mismatch of ["cwd", "id", "path"] as const) {
    await fixture(async (session, root) => {
      const other = path.join(root, "other");
      await mkdir(other);
      const otherFile = path.join(root, "other.jsonl");
      await writeFile(otherFile, history(root));
      const notices: { message: string; level: string }[] = [];
      await assert.rejects(restoreWorkspaceSession({ switchSession: async (_file, options) => {
        await options!.withSession!({ cwd: mismatch === "cwd" ? other : root,
          sessionManager: { getSessionId: () => mismatch === "id" ? "other" : id,
            getSessionFile: () => mismatch === "path" ? otherFile : session.path },
          ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
        } as never);
        return { cancelled: false };
      } }, session, root), (error: unknown) => error instanceof WorkspaceRestoreError && error.replaced);
      assert.equal(notices.length, 1);
      assert.equal(notices[0].level, "error");
      assert.match(notices[0].message, /恢复验证失败/);
    });
  }
});

test("会话显示名称、时间和短 ID，发生碰撞仍能逐个选择", () => {
  const session = { path: "/fixture", id, cwd: "/fixture", firstMessage: "first\nmessage", modified: new Date(timestamp) };
  assert.match(workspaceSessionLabels([session])[0], /first message.*33333333/);
  const labels = workspaceSessionLabels([{ ...session, name: "same" }, { ...session, name: "same", id: `${id.slice(0, -1)}4` }]);
  assert.equal(new Set(labels).size, 2);
  assert.ok(labels.every((label) => label.startsWith("same | ")));
});

test("原生迁移丢失自定义 sessionDir 后，parentSession 目录仍能发现原历史", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  await fixture(async (session, root) => {
    const agent = path.join(root, "agent");
    const custom = path.join(root, "custom-source");
    const linked = path.join(root, "linked");
    await mkdir(agent);
    await mkdir(custom);
    await mkdir(linked);
    process.env.PI_CODING_AGENT_DIR = agent;
    const sourceFile = path.join(custom, "source.jsonl");
    const sourceContent = history(root);
    await writeFile(sourceFile, sourceContent);
    const fork = SessionManager.forkFrom(sourceFile, linked);
    const reopened = SessionManager.open(fork.getSessionFile()!);
    assert.notEqual(reopened.getSessionDir(), custom);
    assert.equal(reopened.getHeader()?.parentSession, sourceFile);
    assert.deepEqual(await discoverWorkspaceSessions(root, reopened.getSessionDir()), []);
    const candidates = await discoverWorkspaceSessions(root, reopened.getSessionDir(), reopened.getHeader()?.parentSession);
    assert.deepEqual(candidates.map((candidate) => [candidate.path, candidate.id]), [[sourceFile, session.id]]);
    assert.equal(await readFile(sourceFile, "utf8"), sourceContent);
  }).finally(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
});

test("内存会话的空 sessionDir 不传给原生扫描，空 parentSession 也不隐式指向 cwd", async (t) => {
  const scannedDirectories: (string | undefined)[] = [];
  t.mock.method(SessionManager, "list", async () => []);
  t.mock.method(SessionManager, "listAll", async (directory?: string) => {
    scannedDirectories.push(directory);
    assert.notEqual(directory, "", "空目录会被 SDK normalize 成当前目录");
    return [];
  });
  await fixture(async (_session, root) => {
    assert.deepEqual(await discoverWorkspaceSessions(root, "", ""), []);
    assert.deepEqual(scannedDirectories, [undefined], "只允许原生默认历史回退，不扫描当前目录");
  });
});

test("发现覆盖当前自定义目录和默认 alias 目录，canonical 去重，严格排除 nested/legacy/cross-target", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  await fixture(async (session, root) => {
    const agent = path.join(root, "agent");
    const active = path.join(root, "custom");
    const alias = path.join(root, "alias");
    const target = path.join(root, "target");
    await mkdir(agent);
    await mkdir(active);
    await mkdir(target);
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    process.env.PI_CODING_AGENT_DIR = agent;
    const canonical = await realpath(target);
    const customFile = path.join(active, "custom.jsonl");
    await writeFile(customFile, history(alias));
    await symlink(customFile, path.join(active, "duplicate.jsonl"));
    await writeFile(path.join(active, "cross.jsonl"), history(root));
    await writeFile(path.join(active, "legacy.jsonl"), `${JSON.stringify({ type: "session", id, timestamp })}\n`);
    await mkdir(path.join(target, "nested"));
    await writeFile(path.join(active, "nested.jsonl"), history(path.join(target, "nested")));
    const sessions = await discoverWorkspaceSessions(canonical, active);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].path, await realpath(customFile));
    assert.equal(sessions[0].cwd, canonical);
    await preflightWorkspaceSession(sessions[0], canonical);
    await rm(customFile);
    await rm(path.join(active, "duplicate.jsonl"));
    // 目标 canonical 编码目录无候选时，原生 listAll 才回退搜索 alias 编码的默认目录。
    const aliasManager = SessionManager.create(alias);
    const aliasFile = aliasManager.getSessionFile()!;
    await writeFile(aliasFile, history(alias, "55555555-5555-7555-8555-555555555555"));
    const fallback = await discoverWorkspaceSessions(canonical, active);
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].path, await realpath(aliasFile));
    assert.equal(fallback[0].cwd, canonical);
    assert.equal((await discoverWorkspaceSessions(session.cwd, active)).length, 1);
  }).finally(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
});
