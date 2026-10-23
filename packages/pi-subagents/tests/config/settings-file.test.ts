import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSettingsFile, updateSettingsFile } from "#src/config/settings-file";

describe("settings-file", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-settings-file-"));
    file = join(dir, "nested", "subagents.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a missing file and updates only the requested keys", () => {
    expect(readSettingsFile(file)).toBeUndefined();

    updateSettingsFile(file, (current) => ({ ...current, maxConcurrent: 6 }));
    updateSettingsFile(file, (current) => ({ ...current, agentEnabled: { worker: false } }));

    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
      maxConcurrent: 6,
      agentEnabled: { worker: false },
    });
  });

  it("rejects malformed and non-object content without changing it", () => {
    mkdirSync(join(dir, "nested"), { recursive: true });
    for (const content of ["not json", "[]", "null"]) {
      writeFileSync(file, content);
      expect(() => updateSettingsFile(file, (current) => ({ ...current, maxConcurrent: 6 }))).toThrow();
      expect(readFileSync(file, "utf-8")).toBe(content);
      expect(existsSync(`${file}.lock`)).toBe(false);
    }
  });

  it("preserves the target mode when atomically replacing an existing file", () => {
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(file, JSON.stringify({ maxConcurrent: 4 }));
    chmodSync(file, 0o640);

    updateSettingsFile(file, (current) => ({ ...current, maxConcurrent: 6 }));

    expect(lstatSync(file).mode & 0o777).toBe(0o640);
  });

  it("updates a symlink target without replacing the symlink", () => {
    const target = join(dir, "real-settings.json");
    const link = join(dir, "linked-settings.json");
    writeFileSync(target, JSON.stringify({ future: true }));
    symlinkSync(target, link);

    updateSettingsFile(link, (current) => ({ ...current, agentEnabled: { worker: false } }));

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({
      future: true,
      agentEnabled: { worker: false },
    });
  });

  it("uses the real parent for new files reached through an ancestor symlink", () => {
    const realParent = join(dir, "real-parent");
    const linkedParent = join(dir, "linked-parent");
    mkdirSync(realParent);
    symlinkSync(realParent, linkedParent);
    const linkedFile = join(linkedParent, "subagents.json");

    updateSettingsFile(linkedFile, (current) => ({ ...current, maxConcurrent: 6 }));

    expect(JSON.parse(readFileSync(join(realParent, "subagents.json"), "utf-8"))).toEqual({ maxConcurrent: 6 });
    expect(lstatSync(linkedFile).isSymbolicLink()).toBe(false);
  });

  it("rejects a dangling symlink without replacing the link", () => {
    const missingTarget = join(dir, "missing-settings.json");
    const link = join(dir, "dangling-settings.json");
    symlinkSync(missingTarget, link);

    expect(() => updateSettingsFile(link, (current) => ({ ...current, maxConcurrent: 6 }))).toThrow();
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(missingTarget);
    expect(existsSync(missingTarget)).toBe(false);
  });

  it("leaves a busy lock and the original file intact", () => {
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(file, JSON.stringify({ maxConcurrent: 4 }));
    writeFileSync(`${file}.lock`, "other writer");

    expect(() => updateSettingsFile(file, (current) => ({ ...current, maxConcurrent: 6 }))).toThrow();
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ maxConcurrent: 4 });
    expect(existsSync(`${file}.lock`)).toBe(true);
  });

  it("recovers an expired lock whose owner process no longer exists", () => {
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(file, JSON.stringify({ maxConcurrent: 4 }));
    const lock = `${file}.lock`;
    writeFileSync(lock, "2147483647\\n");
    const expired = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lock, expired, expired);

    updateSettingsFile(file, (current) => ({ ...current, maxConcurrent: 6 }));

    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ maxConcurrent: 6 });
    expect(existsSync(lock)).toBe(false);
  });

  it("cleans up its lock and temporary file after an updater failure", () => {
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(file, JSON.stringify({ maxConcurrent: 4 }));

    expect(() => updateSettingsFile(file, () => {
      throw new Error("stop");
    })).toThrow("stop");

    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ maxConcurrent: 4 });
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(readdirSync(join(dir, "nested")).some((name) => name.includes(".tmp-"))).toBe(false);
  });
});
