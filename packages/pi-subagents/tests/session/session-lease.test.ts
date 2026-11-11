import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireSessionLease } from "#src/session/session-lease";

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "subagents-lease-"))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("persistent child session ownership", () => {
  it("uses an exclusive real-file marker before a transcript exists", () => {
    const file = join(root, "not-created.jsonl");
    const lease = acquireSessionLease(file, "child-id");
    const bytes = readFileSync(lease.path, "utf8");
    expect(JSON.parse(bytes)).toEqual({ token: lease.token });
    // POSIX 必须保持 0600；Windows 的 stat 不报告创建模式，此处只验证真实文件与租约语义。
    if (process.platform !== "win32") expect(statSync(lease.path).mode & 0o777).toBe(0o600);
    expect(existsSync(file)).toBe(false);
    expect(() => acquireSessionLease(file, "child-id")).toThrow(/already held/);
    expect(readFileSync(lease.path, "utf8")).toBe(bytes);
    lease.release();
    expect(existsSync(lease.path)).toBe(false);
    lease.release();
    const next = acquireSessionLease(file, "child-id");
    expect(next.token).not.toBe(lease.token);
    next.release();
  });

  it("shares ownership across normalized paths, different filenames and symlinked directories", () => {
    const directory = join(root, "real");
    const alias = join(root, "alias");
    mkdirSync(directory);
    mkdirSync(join(directory, "nested"));
    // Windows 普通用户可创建 junction；两者都由生产 realpath 归一为同一目录，互斥语义不变。
    symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
    const lease = acquireSessionLease(join(directory, "nested", "..", "child.jsonl"), "child-id");
    expect(lease.path).toBe(join(directory, ".child-id.subagents-lease"));
    expect(() => acquireSessionLease(join(alias, "renamed.jsonl"), "child-id")).toThrow(/already held/);
    const other = acquireSessionLease(join(alias, "child.jsonl"), "other-child");
    other.release();
    lease.release();
  });

  it("refuses to delete a marker whose token belongs to another owner", () => {
    const lease = acquireSessionLease(join(root, "child.jsonl"), "child-id");
    const replacement = JSON.stringify({ token: "different-owner" });
    writeFileSync(lease.path, replacement);
    expect(() => lease.release()).toThrow(/owner changed/);
    expect(readFileSync(lease.path, "utf8")).toBe(replacement);
    expect(() => acquireSessionLease(join(root, "child.jsonl"), "child-id")).toThrow(/already held/);
  });

  it("never automatically removes a crashed owner's old marker", () => {
    const path = join(root, ".child-id.subagents-lease");
    const residue = JSON.stringify({ token: "crashed-owner", pid: -1, createdAt: 0 });
    writeFileSync(path, residue);
    expect(() => acquireSessionLease(join(root, "child.jsonl"), "child-id")).toThrow(/automatic recovery is forbidden/);
    expect(readFileSync(path, "utf8")).toBe(residue);
  });

  it.each(["", "../escape", "with/slash", "with space"])("rejects unsafe session ID %j without writing a marker", (id) => {
    expect(() => acquireSessionLease(join(root, "child.jsonl"), id)).toThrow(/Invalid child session ID/);
    expect(existsSync(join(root, ".subagents-lease"))).toBe(false);
  });
});
