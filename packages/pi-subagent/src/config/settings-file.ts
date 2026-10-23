import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const LOCK_STALE_MS = 5 * 60 * 1000;

export type JsonObject = Record<string, unknown>;

/** Read a JSON object from disk. A missing file is reported as undefined. */
export function readSettingsFile(path: string): JsonObject | undefined {
  try {
    return parseJsonObject(readFileSync(path, "utf-8"), path);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

/**
 * Atomically update one JSON settings file while preserving unrelated keys.
 * The updater runs after acquiring the lock and re-reading the current file.
 */
export function updateSettingsFile(path: string, update: (current: JsonObject) => JsonObject): void {
  mkdirSync(dirname(path), { recursive: true });

  const targetPath = resolveWriteTarget(path);
  const lockPath = `${targetPath}.lock`;
  let lockFd: number | undefined;
  let tempPath: string | undefined;

  try {
    lockFd = acquireLock(lockPath);
    const current = readSettingsFile(targetPath) ?? {};
    const next = update(current);
    if (!isJsonObject(next)) {
      throw new TypeError("Settings file updates must produce a JSON object");
    }

    const mode = existingMode(targetPath);
    tempPath = join(dirname(targetPath), `.${basename(targetPath)}.tmp-${process.pid}-${randomUUID()}`);
    writeTempFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, mode);
    renameSync(tempPath, targetPath);
    tempPath = undefined;
  } finally {
    if (tempPath) rmSync(tempPath, { force: true });
    if (lockFd !== undefined) {
      closeSync(lockFd);
      rmSync(lockPath, { force: true });
    }
  }
}

function acquireLock(lockPath: string): number {
  try {
    return createLock(lockPath);
  } catch (error) {
    if (!isExistingFileError(error) || !recoverStaleLock(lockPath)) throw error;
    return createLock(lockPath);
  }
}

function createLock(lockPath: string): number {
  const fd = openSync(lockPath, "wx", 0o600);
  try {
    writeFileSync(fd, `${process.pid}\\n`, "utf-8");
    return fd;
  } catch (error) {
    closeSync(fd);
    rmSync(lockPath, { force: true });
    throw error;
  }
}

function recoverStaleLock(lockPath: string): boolean {
  let before: ReturnType<typeof statSync>;
  try {
    before = statSync(lockPath);
  } catch {
    return false;
  }
  if (Date.now() - before.mtimeMs < LOCK_STALE_MS) return false;

  const content = readFileSync(lockPath, "utf-8").trim();
  const pid = Number.parseInt(content, 10);
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (!isMissingProcessError(error)) return false;
    }
  }

  let after: ReturnType<typeof statSync>;
  try {
    after = statSync(lockPath);
  } catch {
    return false;
  }
  if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) return false;
  rmSync(lockPath);
  return true;
}

function isExistingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isMissingProcessError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

function parseJsonObject(content: string, path: string): JsonObject {
  const parsed: unknown = JSON.parse(content);
  if (!isJsonObject(parsed)) {
    throw new TypeError(`Settings file at ${path} must contain a JSON object`);
  }
  return parsed;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function resolveWriteTarget(path: string): string {
  let entry: ReturnType<typeof lstatSync> | undefined;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }

  // A dangling symlink is an existing link and must never be replaced.
  if (entry?.isSymbolicLink()) return realpathSync(path);

  // Canonicalizing the parent also makes aliases through ancestor symlinks
  // share one lock and ensures a new file is created beside the real parent.
  return join(realpathSync(dirname(path)), basename(path));
}

function existingMode(path: string): number {
  try {
    return statSync(path).mode & 0o777;
  } catch (error) {
    if (isMissingFileError(error)) return 0o600;
    throw error;
  }
}

function writeTempFile(path: string, content: string, mode: number): void {
  const fd = openSync(path, "wx", mode);
  try {
    writeFileSync(fd, content, "utf-8");
    chmodSync(path, mode);
  } finally {
    closeSync(fd);
  }
}
