import assert from "node:assert/strict";
import test from "node:test";

import { buildReviewOverhead, loadSourceSnapshot } from "../core/index.ts";
import { assistant, header, user, writeSession } from "./fixtures.ts";

test("复盘自身开销使用独立 DTO 且核心 coverage 不等同 reasoning", async (t) => {
  const kickoff = "/skill:analyze-efficiency compact projection";
  const sourcePath = await writeSession(t, [
    header(3, { id: "review-session" }),
    user("kickoff", null, 0, kickoff),
    assistant("final", "kickoff", 2),
  ]);
  const snapshot = await loadSourceSnapshot(sourcePath);
  const overhead = await buildReviewOverhead(snapshot);

  assert.equal(overhead.reviewSessionId, "review-session");
  assert.equal(overhead.startEntryId, "kickoff");
  assert.equal(overhead.endEntryId, "final");
  assert.equal(overhead.wallClockSpanSeconds, 2);
  assert.equal(overhead.modelResponses, 1);
  assert.equal(overhead.toolCalls, 0);
  assert.equal(overhead.kickoffBytes, Buffer.byteLength(kickoff, "utf8"));
  assert.equal(overhead.sessionBytes, snapshot.byteLength);
  assert.equal(overhead.tokens.totalTokens, 16);
  assert.equal(overhead.cost.total, 0.2);
  assert.equal(overhead.coverage.requiredMetricsComplete, true);
  assert.equal(overhead.coverage.reasoningComplete, false);
  assert.ok(Object.isFrozen(overhead));
});
