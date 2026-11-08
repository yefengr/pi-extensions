import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveSubagentSessionDir } from "#src/session/session-dir";

describe("deriveSubagentSessionDir", () => {
  it("returns a tasks/ subdirectory nested under the parent session basename", () => {
    // Native absolute fixture with a space: exercises the drive letter and the native
    // separators on Windows without creating anything on disk.
    const sessionsDir = join(tmpdir(), "pi sessions", "--project--");
    const parentSessionFile = join(sessionsDir, "2026-05-20T12-00-00Z_.jsonl");
    const cwd = join(tmpdir(), "pi sessions", "project");

    const result = deriveSubagentSessionDir(parentSessionFile, cwd);

    expect(result).toBe(join(sessionsDir, "2026-05-20T12-00-00Z_", "tasks"));
  });

  it("strips the .jsonl extension from the parent session basename", () => {
    const sessionsDir = join(tmpdir(), "sessions");

    const result = deriveSubagentSessionDir(join(sessionsDir, "abc123.jsonl"), join(tmpdir(), "tmp"));

    expect(result).toBe(join(sessionsDir, "abc123", "tasks"));
  });

  it("handles parent session files without a .jsonl extension", () => {
    const sessionsDir = join(tmpdir(), "sessions");

    const result = deriveSubagentSessionDir(join(sessionsDir, "abc123"), join(tmpdir(), "tmp"));

    // basename is "abc123" (no extension to strip)
    expect(result).toBe(join(sessionsDir, "abc123", "tasks"));
  });

  it("returns a temp directory when parentSessionFile is undefined", () => {
    const result = deriveSubagentSessionDir(undefined, "/home/user/project");
    // Should contain pi-subagent prefix, encoded cwd, and end with tasks
    expect(result).toMatch(/pi-subagent-/);
    expect(result).toContain("home-user-project");
    expect(result).toMatch(/tasks$/);
  });
});
