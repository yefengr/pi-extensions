import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { isTaskEfficiencyReviewSession } from "../src/review-session.ts";

function reviewMarker(): SessionEntry {
  return {
    type: "custom",
    id: "source-marker",
    parentId: null,
    timestamp: "2026-09-10T00:00:00.000Z",
    customType: "task-efficiency:source",
    data: {},
  } as unknown as SessionEntry;
}

test("review marker 只匹配 task-efficiency source custom entry", () => {
  assert.equal(isTaskEfficiencyReviewSession([reviewMarker()]), true);
  assert.equal(isTaskEfficiencyReviewSession([{
    ...reviewMarker(),
    type: "message",
  } as unknown as SessionEntry]), false);
  assert.equal(isTaskEfficiencyReviewSession([{
    ...reviewMarker(),
    customType: "task-efficiency:report",
  } as unknown as SessionEntry]), false);
  assert.equal(isTaskEfficiencyReviewSession([]), false);
});
