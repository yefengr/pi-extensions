import assert from "node:assert/strict";
import test from "node:test";
import { formatLocalTime, formatRemoveResult, formatWorktreeRecord } from "../src/worktree-format.ts";

const timestamp = "2026-09-28T08:00:00.000Z";

test("工作树时间使用当前进程本地时区，结构化时间不变", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "Asia/Shanghai";
    assert.match(formatLocalTime(timestamp), /2026\/09\/28 16:00:00 GMT\+8/);
    process.env.TZ = "America/New_York";
    assert.match(formatLocalTime(timestamp), /2026\/09\/28 04:00:00 GMT-4/);
    assert.equal(formatLocalTime(undefined), "无法读取");

    const record = {
      path: "/worktrees/task",
      branch: "feat/task",
      detached: false,
      bare: false,
      createdAt: timestamp,
      lastCommitAt: timestamp,
    };
    assert.match(formatWorktreeRecord(record), /最近提交：2026\/09\/28 04:00:00 GMT-4/);
    assert.equal(record.createdAt, timestamp);
    assert.match(formatRemoveResult({
      repoPath: "/repo",
      worktreePath: record.path,
      branch: record.branch,
      createdAt: timestamp,
      lastCommitAt: timestamp,
      branchStatus: "deleted",
    }), /创建：2026\/09\/28 04:00:00 GMT-4/);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
