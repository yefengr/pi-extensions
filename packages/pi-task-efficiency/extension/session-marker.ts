import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { SOURCE_ENTRY_TYPE } from "./records.ts";

/** Reads only candidate JSONL records and never materializes a complete session. */
export async function hasSourceMarkerInSession(sourcePath: string): Promise<boolean> {
  const input = createReadStream(sourcePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!mayContainSourceMarker(line)) continue;
      const value: unknown = JSON.parse(line);
      if (isSourceMarker(value)) return true;
    }
    return false;
  } finally {
    lines.close();
    input.destroy();
  }
}

function mayContainSourceMarker(line: string): boolean {
  return line.includes('"type"') && line.includes('"customType"') && line.includes(SOURCE_ENTRY_TYPE);
}

function isSourceMarker(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return entry.type === "custom" && entry.customType === SOURCE_ENTRY_TYPE;
}
