import type { SessionInfo } from "@earendil-works/pi-coding-agent";

import { REVIEW_NAME_PREFIX } from "./records.ts";
import { hasSourceMarkerInSession } from "./session-marker.ts";

const MARKER_SCAN_CONCURRENCY = 4;

export async function filterSourceSessions(
  sessions: readonly SessionInfo[],
  hasReviewMarker: (sourcePath: string) => Promise<boolean>,
): Promise<readonly SessionInfo[]> {
  const included = sessions.map((session) => !session.name?.startsWith(REVIEW_NAME_PREFIX));
  const candidates = sessions.flatMap((session, index) => included[index] ? [{ index, path: session.path }] : []);
  await scanCandidateMarkers(candidates, included, hasReviewMarker);
  return sessions.filter((_session, index) => included[index]);
}

export async function defaultHasReviewMarker(sourcePath: string): Promise<boolean> {
  return hasSourceMarkerInSession(sourcePath);
}

async function scanCandidateMarkers(
  candidates: readonly { readonly index: number; readonly path: string }[],
  included: boolean[],
  hasReviewMarker: (sourcePath: string) => Promise<boolean>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const candidate = candidates[next++]!;
      try {
        if (await hasReviewMarker(candidate.path)) included[candidate.index] = false;
      } catch {
        // Keep the candidate; final strict loading reports a stable public error if needed.
      }
    }
  };
  const workers = Array.from({ length: Math.min(MARKER_SCAN_CONCURRENCY, candidates.length) }, worker);
  await Promise.all(workers);
}
