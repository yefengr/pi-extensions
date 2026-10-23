import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { persistedReceiptIds } from "../src/receipts.ts";
import { RESULT_TYPE } from "../src/constants.ts";

const receipt = (id: string, batchId: string) => ({ id, type: "custom_message", customType: RESULT_TYPE, details: { ownerSessionId: "owner", deliveries: [{ taskId: "task", batchIds: [batchId] }] }, content: "中文\u2028数据" });

test("only complete persisted receipts on active branch count; memory event is not proof", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "monitor-receipts-"));
  const file = path.join(root, "session.jsonl");
  try {
    const valid = receipt("valid", "batch-1");
    const partial = receipt("partial", "batch-2");
    const abandoned = receipt("abandoned", "batch-3");
    const memoryOnly = receipt("memory", "batch-4");
    await writeFile(file, "x".repeat(2_200_000) + "\n" + JSON.stringify(valid) + "\n" + JSON.stringify(abandoned) + "\n" + JSON.stringify(partial));
    assert.deepEqual([...persistedReceiptIds(file, [valid, partial, memoryOnly])], ["valid"]);
    assert.deepEqual([...persistedReceiptIds(file, [valid, abandoned], new Set(["batch-3"]))], ["abandoned"]);
    assert.equal(persistedReceiptIds(file, [valid], new Set()).size, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
