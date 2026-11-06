import path from "node:path";
import type { WorktreeRecord } from "./worktree-types.ts";

export function parseWorktreePorcelain(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | undefined;

  for (const token of output.split("\0")) {
    if (!token) {
      if (current) records.push(current);
      current = undefined;
      continue;
    }

    const separator = token.indexOf(" ");
    const key = separator === -1 ? token : token.slice(0, separator);
    const value = separator === -1 ? "" : token.slice(separator + 1);

    if (key === "worktree") {
      if (current) records.push(current);
      current = { path: value, detached: false, bare: false };
      continue;
    }
    if (!current) continue;

    switch (key) {
      case "HEAD":
        current.head = value;
        break;
      case "branch":
        current.branch = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
        break;
      case "detached":
        current.detached = true;
        break;
      case "bare":
        current.bare = true;
        break;
      case "locked":
        current.locked = value || true;
        break;
      case "prunable":
        current.prunable = value || true;
        break;
    }
  }

  if (current) records.push(current);
  return records;
}

export function isStrictlyWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
