import type { LifecycleRecord } from "./lifecycle.ts";
import type { ProjectionSubagentEntry } from "./types.ts";

/** Select only safe fields after the shared parser has validated the record. */
export function projectLifecycleRecord(record: LifecycleRecord): ProjectionSubagentEntry["record"] {
  return {
    recordVersion: record.recordVersion,
    id: record.id,
    type: record.type,
    status: record.status,
    invocationKind: record.invocationKind,
    invocationIndex: record.invocationIndex,
    toolCallId: record.toolCallId,
    sessionState: record.sessionState,
    sessionId: record.sessionId,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
  };
}
