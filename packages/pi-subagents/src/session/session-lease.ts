import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Local extension ownership only; a crashed owner deliberately leaves its lease behind. */
export interface SessionLease {
  readonly path: string;
  readonly token: string;
  release(): void;
}

export function acquireSessionLease(file: string, sessionId: string): SessionLease {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("Invalid child session ID for lease");
  const path = join(realpathSync(dirname(file)), `.${sessionId}.subagents-lease`);
  const token = randomUUID();
  let descriptor: number;
  try { descriptor = openSync(path, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Child session lease is already held; automatic recovery is forbidden");
    throw error;
  }
  try { writeFileSync(descriptor, JSON.stringify({ token }), "utf8"); }
  finally { closeSync(descriptor); }
  let released = false;
  return {
    path, token,
    release() {
      if (released) return;
      const current = JSON.parse(readFileSync(path, "utf8")) as { token?: unknown };
      if (current.token !== token) throw new Error("Child session lease owner changed");
      unlinkSync(path);
      released = true;
    },
  };
}
