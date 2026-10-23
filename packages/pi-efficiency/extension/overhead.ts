import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import type { ReviewOverhead, SourceSnapshot } from "../core/index.ts";
import {
  reviewOverheadMarker,
  REVIEW_OVERHEAD_ENTRY_TYPE,
  readReviewState,
  SOURCE_ENTRY_TYPE,
} from "./records.ts";
import { formatReviewOverhead } from "./review-ui.ts";

export interface OverheadDependencies {
  readonly loadSnapshot: (sourcePath: string) => Promise<SourceSnapshot>;
  readonly buildOverhead: (snapshot: SourceSnapshot) => Promise<ReviewOverhead>;
  readonly now: () => Date;
}

export async function recordReviewOverhead(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  dependencies: OverheadDependencies,
  failedReviewSessions: WeakSet<object>,
  recordingReviewSessions: WeakSet<object>,
): Promise<void> {
  if (failedReviewSessions.has(ctx.sessionManager) || recordingReviewSessions.has(ctx.sessionManager)) return;
  const currentBranch = ctx.sessionManager.getBranch();
  if (!currentBranch.some(isReviewSourceEntry) || currentBranch.some(isReviewOverheadEntry)) return;
  const reviewPath = ctx.sessionManager.getSessionFile();
  if (!reviewPath) return;
  recordingReviewSessions.add(ctx.sessionManager);
  try {
    const snapshot = await dependencies.loadSnapshot(reviewPath);
    if (snapshot.sessionId !== ctx.sessionManager.getSessionId()) return;
    const entries = snapshot.activeBranch.map((entry) => entry.raw as unknown as SessionEntry);
    if (!entries.some(isReviewSourceEntry) || entries.some(isReviewOverheadEntry)) return;
    if (readReviewState(entries).phase !== "reported") return;
    const overhead = await dependencies.buildOverhead(snapshot);
    pi.appendEntry(REVIEW_OVERHEAD_ENTRY_TYPE, reviewOverheadMarker(overhead, dependencies.now()));
    if (ctx.hasUI) ctx.ui.notify(formatReviewOverhead(overhead), "info");
  } catch {
    if (ctx.hasUI) ctx.ui.notify("复盘自身开销暂不可用。", "warning");
  } finally {
    recordingReviewSessions.delete(ctx.sessionManager);
  }
}

function isReviewSourceEntry(entry: SessionEntry): boolean {
  return entry.type === "custom" && entry.customType === SOURCE_ENTRY_TYPE;
}

function isReviewOverheadEntry(entry: SessionEntry): boolean {
  return entry.type === "custom" && entry.customType === REVIEW_OVERHEAD_ENTRY_TYPE;
}
