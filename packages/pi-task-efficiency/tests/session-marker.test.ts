import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { hasSourceMarkerInSession } from "../src/extension/session-marker.ts";

const marker = JSON.stringify({ type: "custom", customType: "task-efficiency:source", data: {} });

test("候选扫描流式识别任意位置的 source marker", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "efficiency-marker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const early = path.join(directory, "early.jsonl");
  await writeFile(early, `${JSON.stringify({ type: "session" })}\n${marker}\n${"x".repeat(100_000)}\n`, "utf8");
  assert.equal(await hasSourceMarkerInSession(early), true);

  const late = path.join(directory, "late.jsonl");
  const prefix = Array.from({ length: 16 }, (_value, index) => JSON.stringify({ type: "metadata", index }));
  await writeFile(late, `${prefix.join("\n")}\n${marker}\n`, "utf8");
  assert.equal(await hasSourceMarkerInSession(late), true);
});
