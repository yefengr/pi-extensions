import { createHash } from "node:crypto";
import path from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { ReviewOverhead, SessionProjection, SourceSnapshot, ValidatedTaskRange } from "../core/index.ts";
import { fail } from "./errors.ts";

export const REVIEW_NAME_PREFIX = "task-efficiency:review:";
export const SOURCE_ENTRY_TYPE = "task-efficiency:source";
export const PROPOSAL_ENTRY_TYPE = "task-efficiency:proposal";
export const REVISION_ENTRY_TYPE = "task-efficiency:revision";
export const TERMINATION_ENTRY_TYPE = "task-efficiency:termination";
export const CONFIRMATION_ENTRY_TYPE = "task-efficiency:confirmation";
export const REPORT_ENTRY_TYPE = "task-efficiency:report";
export const REVIEW_OVERHEAD_ENTRY_TYPE = "task-efficiency:review-overhead";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CONFIDENCE_VALUES = new Set(["high", "medium", "low"]);

export type Confidence = "high" | "medium" | "low";
export type ReviewTerminationReason = "cancelled" | "reselected";
export type ReviewPhase = "empty" | "open" | "revised" | "confirmed" | "reported"
  | ReviewTerminationReason;
type CustomType =
  | typeof SOURCE_ENTRY_TYPE
  | typeof PROPOSAL_ENTRY_TYPE
  | typeof REVISION_ENTRY_TYPE
  | typeof TERMINATION_ENTRY_TYPE
  | typeof CONFIRMATION_ENTRY_TYPE
  | typeof REPORT_ENTRY_TYPE;

export interface SourceReference {
  readonly schemaVersion: 1;
  readonly sourcePath: string;
  readonly sourceSessionId: string;
  readonly sourceDigest: string;
  readonly sourceActiveLeafId: string | null;
  readonly projectionDigest: string;
}

export interface ScopeProposal {
  readonly schemaVersion: 1;
  readonly proposalId: string;
  readonly sourceDigest: string;
  readonly summary: string;
  readonly startEntryId: string;
  readonly endEntryId: string;
  readonly startTimestamp: string;
  readonly endTimestamp: string;
  readonly included: readonly string[];
  readonly excluded: readonly string[];
  readonly rationale: string;
  readonly evidenceEntryIds: readonly string[];
  readonly confidence: Confidence;
  readonly createdAt: string;
}

export interface ScopeRevision {
  readonly schemaVersion: 1;
  readonly proposalId: string;
  readonly correction: string;
  readonly createdAt: string;
}

export interface ScopeConfirmation {
  readonly schemaVersion: 1;
  readonly proposalId: string;
  readonly sourceDigest: string;
  readonly startEntryId: string;
  readonly endEntryId: string;
  readonly confirmedAt: string;
}

export interface ScopeTermination {
  readonly schemaVersion: 1;
  readonly proposalId: string;
  readonly reason: ReviewTerminationReason;
  readonly createdAt: string;
}

export interface ReviewOverheadMarker extends ReviewOverhead {
  readonly createdAt: string;
}

interface CompactReportMarker {
  readonly schemaVersion: 1;
  readonly proposalId: string;
  readonly sourceDigest: string;
  readonly startEntryId: string;
  readonly endEntryId: string;
  readonly reportDigest: string;
  readonly createdAt: string;
}

export interface ReviewState {
  readonly source: SourceReference;
  readonly phase: ReviewPhase;
  readonly latestProposal: ScopeProposal | null;
  readonly latestConfirmation: ScopeConfirmation | null;
}

export interface ProposalInput {
  readonly summary: string;
  readonly startEntryId: string;
  readonly endEntryId: string;
  readonly included: readonly string[];
  readonly excluded: readonly string[];
  readonly rationale: string;
  readonly evidenceEntryIds: readonly string[];
  readonly confidence: Confidence;
}

export function projectionDigest(projection: SessionProjection): string {
  return sha256(JSON.stringify(projection));
}

export function buildSourceReference(snapshot: SourceSnapshot, digest: string): SourceReference {
  return Object.freeze({
    schemaVersion: 1,
    sourcePath: snapshot.sourcePath,
    sourceSessionId: snapshot.sessionId,
    sourceDigest: snapshot.digest,
    sourceActiveLeafId: snapshot.activeLeafId,
    projectionDigest: digest,
  });
}

export function createProposal(
  input: ProposalInput,
  snapshot: SourceSnapshot,
  range: ValidatedTaskRange,
  now: Date,
): ScopeProposal {
  const normalized = normalizeProposalInput(input);
  const startTimestamp = range.turns[0]?.startTimestamp;
  const endTimestamp = range.turns.at(-1)?.endTimestamp;
  if (startTimestamp === null || startTimestamp === undefined || endTimestamp === null || endTimestamp === undefined) {
    fail("TASK_EFFICIENCY_PROPOSAL_INVALID");
  }
  const proposal = Object.freeze({ ...normalized, startTimestamp, endTimestamp });

  const selectedIds = new Set(snapshot.activeBranch.slice(range.startIndex, range.endIndex + 1).map((entry) => entry.id));
  if (proposal.evidenceEntryIds.some((entryId) => !selectedIds.has(entryId))) {
    fail("TASK_EFFICIENCY_PROPOSAL_INVALID");
  }

  const createdAt = validIso(now) ? now.toISOString() : fail("TASK_EFFICIENCY_INTERNAL");
  const sourceDigest = snapshot.digest;
  return Object.freeze({
    schemaVersion: 1,
    proposalId: proposalId({ ...proposal, sourceDigest }),
    sourceDigest,
    ...proposal,
    createdAt,
  });
}

export function proposalId(proposal: Omit<ScopeProposal, "schemaVersion" | "proposalId" | "createdAt">): string {
  return sha256(JSON.stringify({
    sourceDigest: proposal.sourceDigest,
    summary: proposal.summary,
    startEntryId: proposal.startEntryId,
    endEntryId: proposal.endEntryId,
    startTimestamp: proposal.startTimestamp,
    endTimestamp: proposal.endTimestamp,
    included: proposal.included,
    excluded: proposal.excluded,
    rationale: proposal.rationale,
    evidenceEntryIds: proposal.evidenceEntryIds,
    confidence: proposal.confidence,
  }));
}

export function readReviewState(entries: readonly SessionEntry[]): ReviewState {
  const records = entries.flatMap((entry, index) => parseKnownCustomEntry(entry, index));
  const sources = records.filter((record): record is ParsedRecord<typeof SOURCE_ENTRY_TYPE> => record.type === SOURCE_ENTRY_TYPE);
  if (sources.length !== 1 || records[0]?.type !== SOURCE_ENTRY_TYPE) {
    fail("TASK_EFFICIENCY_REVIEW_STATE_INVALID");
  }

  const source = sources[0].data;
  let phase: ReviewPhase = "empty";
  let latestProposal: ScopeProposal | null = null;
  let latestConfirmation: ScopeConfirmation | null = null;
  const proposalIds = new Set<string>();

  for (const record of records.slice(1)) {
    switch (record.type) {
      case PROPOSAL_ENTRY_TYPE:
        if (phase !== "empty" && phase !== "revised" || proposalIds.has(record.data.proposalId)) {
          fail("TASK_EFFICIENCY_REVIEW_STATE_INVALID");
        }
        if (record.data.sourceDigest !== source.sourceDigest) fail("TASK_EFFICIENCY_REVIEW_STATE_INVALID");
        proposalIds.add(record.data.proposalId);
        latestProposal = record.data;
        latestConfirmation = null;
        phase = "open";
        break;
      case REVISION_ENTRY_TYPE:
        if (phase !== "open" || latestProposal === null || record.data.proposalId !== latestProposal.proposalId) {
          fail("TASK_EFFICIENCY_REVIEW_STATE_INVALID");
        }
        phase = "revised";
        break;
      case TERMINATION_ENTRY_TYPE:
        if (phase !== "open" || latestProposal === null || record.data.proposalId !== latestProposal.proposalId) {
          fail("TASK_EFFICIENCY_REVIEW_STATE_INVALID");
        }
        phase = record.data.reason;
        break;
      case CONFIRMATION_ENTRY_TYPE:
        if (phase !== "open" || latestProposal === null || !confirmationMatches(record.data, latestProposal)) {
          fail("TASK_EFFICIENCY_REVIEW_STATE_INVALID");
        }
        latestConfirmation = record.data;
        phase = "confirmed";
        break;
      case REPORT_ENTRY_TYPE:
        if (phase !== "confirmed" || latestProposal === null || latestConfirmation === null
          || !reportMatches(record.data, latestProposal, latestConfirmation)) {
          fail("TASK_EFFICIENCY_REVIEW_STATE_INVALID");
        }
        phase = "reported";
        break;
      default:
        fail("TASK_EFFICIENCY_REVIEW_STATE_INVALID");
    }
  }

  return Object.freeze({ source, phase, latestProposal, latestConfirmation });
}

export function confirmationForProposal(proposal: ScopeProposal, now: Date): ScopeConfirmation {
  const confirmedAt = validIso(now) ? now.toISOString() : fail("TASK_EFFICIENCY_INTERNAL");
  return Object.freeze({
    schemaVersion: 1,
    proposalId: proposal.proposalId,
    sourceDigest: proposal.sourceDigest,
    startEntryId: proposal.startEntryId,
    endEntryId: proposal.endEntryId,
    confirmedAt,
  });
}

export function revisionForProposal(proposalId: string, correction: string, now: Date): ScopeRevision {
  const normalizedCorrection = normalizeRequiredText(correction);
  const createdAt = validIso(now) ? now.toISOString() : fail("TASK_EFFICIENCY_INTERNAL");
  return Object.freeze({ schemaVersion: 1, proposalId, correction: normalizedCorrection, createdAt });
}

export function terminationForProposal(
  proposalId: string,
  reason: ReviewTerminationReason,
  now: Date,
): ScopeTermination {
  const createdAt = validIso(now) ? now.toISOString() : fail("TASK_EFFICIENCY_INTERNAL");
  return Object.freeze({ schemaVersion: 1, proposalId, reason, createdAt });
}

export function reviewOverheadMarker(overhead: ReviewOverhead, now: Date): ReviewOverheadMarker {
  const createdAt = validIso(now) ? now.toISOString() : fail("TASK_EFFICIENCY_INTERNAL");
  return Object.freeze({ ...overhead, createdAt });
}

export function compactReportMarker(
  proposal: ScopeProposal,
  reportJson: string,
  now: Date,
): CompactReportMarker {
  const createdAt = validIso(now) ? now.toISOString() : fail("TASK_EFFICIENCY_INTERNAL");
  return Object.freeze({
    schemaVersion: 1,
    proposalId: proposal.proposalId,
    sourceDigest: proposal.sourceDigest,
    startEntryId: proposal.startEntryId,
    endEntryId: proposal.endEntryId,
    reportDigest: sha256(reportJson),
    createdAt,
  });
}

function parseKnownCustomEntry(entry: SessionEntry, index: number): readonly ParsedRecord<CustomType>[] {
  if (entry.type !== "custom" || !isKnownCustomType(entry.customType)) return [];
  const type = entry.customType;
  const data = entry.data;
  switch (type) {
    case SOURCE_ENTRY_TYPE:
      return [{ type, index, data: parseSource(data) }];
    case PROPOSAL_ENTRY_TYPE:
      return [{ type, index, data: parseProposal(data) }];
    case REVISION_ENTRY_TYPE:
      return [{ type, index, data: parseRevision(data) }];
    case TERMINATION_ENTRY_TYPE:
      return [{ type, index, data: parseTermination(data) }];
    case CONFIRMATION_ENTRY_TYPE:
      return [{ type, index, data: parseConfirmation(data) }];
    case REPORT_ENTRY_TYPE:
      return [{ type, index, data: parseReportMarker(data) }];
  }
}

type ParsedRecord<T extends CustomType> = T extends typeof SOURCE_ENTRY_TYPE
  ? { readonly type: T; readonly index: number; readonly data: SourceReference }
  : T extends typeof PROPOSAL_ENTRY_TYPE
    ? { readonly type: T; readonly index: number; readonly data: ScopeProposal }
    : T extends typeof REVISION_ENTRY_TYPE
      ? { readonly type: T; readonly index: number; readonly data: ScopeRevision }
      : T extends typeof TERMINATION_ENTRY_TYPE
        ? { readonly type: T; readonly index: number; readonly data: ScopeTermination }
        : T extends typeof CONFIRMATION_ENTRY_TYPE
          ? { readonly type: T; readonly index: number; readonly data: ScopeConfirmation }
          : { readonly type: T; readonly index: number; readonly data: CompactReportMarker };

function parseSource(value: unknown): SourceReference {
  const data = strictObject(value, [
    "schemaVersion", "sourcePath", "sourceSessionId", "sourceDigest", "sourceActiveLeafId", "projectionDigest",
  ]);
  if (data.schemaVersion !== 1 || !isAbsolutePath(data.sourcePath) || !isNonEmptyString(data.sourceSessionId)
    || !isSha(data.sourceDigest) || !isNullableNonEmptyString(data.sourceActiveLeafId) || !isSha(data.projectionDigest)) {
    fail("TASK_EFFICIENCY_REVIEW_STATE_INVALID");
  }
  return Object.freeze({
    schemaVersion: 1,
    sourcePath: data.sourcePath,
    sourceSessionId: data.sourceSessionId,
    sourceDigest: data.sourceDigest,
    sourceActiveLeafId: data.sourceActiveLeafId,
    projectionDigest: data.projectionDigest,
  });
}

function parseProposal(value: unknown): ScopeProposal {
  const data = strictObject(value, [
    "schemaVersion", "proposalId", "sourceDigest", "summary", "startEntryId", "endEntryId", "startTimestamp",
    "endTimestamp", "included", "excluded", "rationale", "evidenceEntryIds", "confidence", "createdAt",
  ]);
  if (data.schemaVersion !== 1 || !isSha(data.proposalId) || !isSha(data.sourceDigest)
    || !isNormalizedText(data.summary) || !isNormalizedText(data.startEntryId) || !isNormalizedText(data.endEntryId)
    || !isIso(data.startTimestamp) || !isIso(data.endTimestamp) || !isNormalizedText(data.rationale)
    || !isNormalizedStringArray(data.included, true) || !isNormalizedStringArray(data.excluded, false)
    || !isNormalizedStringArray(data.evidenceEntryIds, true) || !isConfidence(data.confidence) || !isIso(data.createdAt)) {
    fail("TASK_EFFICIENCY_REVIEW_STATE_INVALID");
  }
  const proposal: ScopeProposal = Object.freeze({
    schemaVersion: 1,
    proposalId: data.proposalId,
    sourceDigest: data.sourceDigest,
    summary: data.summary,
    startEntryId: data.startEntryId,
    endEntryId: data.endEntryId,
    startTimestamp: data.startTimestamp,
    endTimestamp: data.endTimestamp,
    included: Object.freeze(data.included.slice()),
    excluded: Object.freeze(data.excluded.slice()),
    rationale: data.rationale,
    evidenceEntryIds: Object.freeze(data.evidenceEntryIds.slice()),
    confidence: data.confidence,
    createdAt: data.createdAt,
  });
  if (proposal.proposalId !== proposalId(proposal)) fail("TASK_EFFICIENCY_REVIEW_STATE_INVALID");
  return proposal;
}

function parseRevision(value: unknown): ScopeRevision {
  const data = strictObject(value, ["schemaVersion", "proposalId", "correction", "createdAt"]);
  if (data.schemaVersion !== 1 || !isSha(data.proposalId) || !isNormalizedText(data.correction) || !isIso(data.createdAt)) {
    fail("TASK_EFFICIENCY_REVIEW_STATE_INVALID");
  }
  return Object.freeze({ schemaVersion: 1, proposalId: data.proposalId, correction: data.correction, createdAt: data.createdAt });
}

function parseTermination(value: unknown): ScopeTermination {
  const data = strictObject(value, ["schemaVersion", "proposalId", "reason", "createdAt"]);
  if (data.schemaVersion !== 1 || !isSha(data.proposalId)
    || data.reason !== "cancelled" && data.reason !== "reselected" || !isIso(data.createdAt)) {
    fail("TASK_EFFICIENCY_REVIEW_STATE_INVALID");
  }
  return Object.freeze({ schemaVersion: 1, proposalId: data.proposalId, reason: data.reason, createdAt: data.createdAt });
}

function parseConfirmation(value: unknown): ScopeConfirmation {
  const data = strictObject(value, ["schemaVersion", "proposalId", "sourceDigest", "startEntryId", "endEntryId", "confirmedAt"]);
  if (data.schemaVersion !== 1 || !isSha(data.proposalId) || !isSha(data.sourceDigest)
    || !isNormalizedText(data.startEntryId) || !isNormalizedText(data.endEntryId) || !isIso(data.confirmedAt)) {
    fail("TASK_EFFICIENCY_REVIEW_STATE_INVALID");
  }
  return Object.freeze({
    schemaVersion: 1,
    proposalId: data.proposalId,
    sourceDigest: data.sourceDigest,
    startEntryId: data.startEntryId,
    endEntryId: data.endEntryId,
    confirmedAt: data.confirmedAt,
  });
}

function parseReportMarker(value: unknown): CompactReportMarker {
  const data = strictObject(value, [
    "schemaVersion", "proposalId", "sourceDigest", "startEntryId", "endEntryId", "reportDigest", "createdAt",
  ]);
  if (data.schemaVersion !== 1 || !isSha(data.proposalId) || !isSha(data.sourceDigest) || !isSha(data.reportDigest)
    || !isNormalizedText(data.startEntryId) || !isNormalizedText(data.endEntryId) || !isIso(data.createdAt)) {
    fail("TASK_EFFICIENCY_REVIEW_STATE_INVALID");
  }
  return Object.freeze({
    schemaVersion: 1,
    proposalId: data.proposalId,
    sourceDigest: data.sourceDigest,
    startEntryId: data.startEntryId,
    endEntryId: data.endEntryId,
    reportDigest: data.reportDigest,
    createdAt: data.createdAt,
  });
}

function normalizeProposalInput(
  input: ProposalInput,
): Omit<ScopeProposal, "schemaVersion" | "proposalId" | "sourceDigest" | "startTimestamp" | "endTimestamp" | "createdAt"> {
  const summary = normalizeRequiredText(input.summary);
  const startEntryId = normalizeRequiredText(input.startEntryId);
  const endEntryId = normalizeRequiredText(input.endEntryId);
  const included = normalizeTextArray(input.included, true);
  const excluded = normalizeTextArray(input.excluded, false);
  const rationale = normalizeRequiredText(input.rationale);
  const evidenceEntryIds = normalizeTextArray(input.evidenceEntryIds, true);
  if (!isConfidence(input.confidence)) fail("TASK_EFFICIENCY_PROPOSAL_INVALID");
  return Object.freeze({
    summary,
    startEntryId,
    endEntryId,
    included,
    excluded,
    rationale,
    evidenceEntryIds,
    confidence: input.confidence,
  });
}

function normalizeRequiredText(value: unknown): string {
  if (typeof value !== "string") fail("TASK_EFFICIENCY_PROPOSAL_INVALID");
  const normalized = value.trim();
  if (normalized.length === 0) fail("TASK_EFFICIENCY_PROPOSAL_INVALID");
  return normalized;
}

function normalizeTextArray(value: unknown, required: boolean): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail("TASK_EFFICIENCY_PROPOSAL_INVALID");
  const normalized = stableUnique(value.map((item) => item.trim()).filter(Boolean));
  if (required && normalized.length === 0) fail("TASK_EFFICIENCY_PROPOSAL_INVALID");
  return Object.freeze(normalized);
}

function confirmationMatches(confirmation: ScopeConfirmation, proposal: ScopeProposal): boolean {
  return confirmation.proposalId === proposal.proposalId
    && confirmation.sourceDigest === proposal.sourceDigest
    && confirmation.startEntryId === proposal.startEntryId
    && confirmation.endEntryId === proposal.endEntryId;
}

function reportMatches(marker: CompactReportMarker, proposal: ScopeProposal, confirmation: ScopeConfirmation): boolean {
  return marker.proposalId === proposal.proposalId
    && marker.sourceDigest === confirmation.sourceDigest
    && marker.startEntryId === confirmation.startEntryId
    && marker.endEntryId === confirmation.endEntryId;
}

function strictObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    fail("TASK_EFFICIENCY_REVIEW_STATE_INVALID");
  }
  return value;
}

function isKnownCustomType(value: string): value is CustomType {
  return value === SOURCE_ENTRY_TYPE || value === PROPOSAL_ENTRY_TYPE || value === REVISION_ENTRY_TYPE
    || value === TERMINATION_ENTRY_TYPE || value === CONFIRMATION_ENTRY_TYPE || value === REPORT_ENTRY_TYPE;
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && path.isAbsolute(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function isNormalizedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function isNormalizedStringArray(value: unknown, required: boolean): value is string[] {
  return Array.isArray(value)
    && (!required || value.length > 0)
    && value.every(isNormalizedText)
    && new Set(value).size === value.length;
}

function isConfidence(value: unknown): value is Confidence {
  return typeof value === "string" && CONFIDENCE_VALUES.has(value);
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return validIso(date) && date.toISOString() === value;
}

function validIso(value: Date): boolean {
  return !Number.isNaN(value.valueOf());
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
