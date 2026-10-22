import { type SnapshotEntry, SourceSnapshotError } from "./types.ts";

/** Rebuilds the active path from the final entry after whole-tree validation. */
export function buildActiveBranch(entries: readonly SnapshotEntry[]): readonly SnapshotEntry[] {
  if (entries.length === 0) return Object.freeze([]);

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: SnapshotEntry[] = [];
  const seen = new Set<string>();
  let current: SnapshotEntry | undefined = entries.at(-1);

  while (current !== undefined) {
    if (seen.has(current.id)) {
      throw new SourceSnapshotError("cycle", `session tree contains a cycle at ${current.id}`);
    }
    seen.add(current.id);
    branch.push(current);
    if (current.parentId === null) break;

    const parent = byId.get(current.parentId);
    if (parent === undefined) {
      throw new SourceSnapshotError("missing-parent", `session entry ${current.id} has missing parent ${current.parentId}`);
    }
    current = parent;
  }

  branch.reverse();
  return Object.freeze(branch);
}
