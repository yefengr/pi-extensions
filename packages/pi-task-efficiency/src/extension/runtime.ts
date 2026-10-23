import { StringEnum } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  buildReviewOverhead,
  buildScopeDetailProjection,
  buildScopeProjection,
  buildScopeProjectionPage,
  buildSessionProjection,
  buildTaskEfficiencyReport,
  loadSourceSnapshot,
  ScopeDetailError,
  ScopePageError,
  validateTaskRange,
  type ReviewOverhead,
  type ScopeDetailProjection,
  type ScopeProjection,
  type ScopeProjectionPage,
  type SessionProjection,
  type SourceSnapshot,
  TaskRangeError,
  type TaskEfficiencyReport,
  type ValidatedTaskRange,
} from "../core/index.ts";
import { fail, publicError, TaskEfficiencyError } from "./errors.ts";
import { recordReviewOverhead } from "./overhead.ts";
import { parseScopeAction, scopeActionOptions, scopeSummary, selectSourceSession } from "./review-ui.ts";
import { defaultHasReviewMarker, filterSourceSessions } from "./source-sessions.ts";
import {
  buildSourceReference,
  compactReportMarker,
  CONFIRMATION_ENTRY_TYPE,
  confirmationForProposal,
  createProposal,
  PROPOSAL_ENTRY_TYPE,
  projectionDigest,
  readReviewState as parseReviewState,
  REPORT_ENTRY_TYPE,
  REVIEW_NAME_PREFIX,
  REVISION_ENTRY_TYPE,
  revisionForProposal,
  SOURCE_ENTRY_TYPE,
  TERMINATION_ENTRY_TYPE,
  terminationForProposal,
  type ProposalInput,
  type ReviewState,
  type ScopeProposal,
  type SourceReference,
} from "./records.ts";

const scopeProposalSchema = Type.Object({
  summary: Type.String(),
  startEntryId: Type.String(),
  endEntryId: Type.String(),
  included: Type.Array(Type.String()),
  excluded: Type.Array(Type.String()),
  rationale: Type.String(),
  evidenceEntryIds: Type.Array(Type.String()),
  confidence: StringEnum(["high", "medium", "low"] as const),
}, { additionalProperties: false });

const scopePageSchema = Type.Object({
  beforeCursor: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });

const scopeDetailSchema = Type.Object({
  startEntryId: Type.String(),
  endEntryId: Type.String(),
}, { additionalProperties: false });

const emptySchema = Type.Object({}, { additionalProperties: false });

export interface TaskEfficiencyExtensionDependencies {
  readonly listSessions?: (cwd: string) => Promise<readonly SessionInfo[]>;
  readonly loadSnapshot?: (sourcePath: string) => Promise<SourceSnapshot>;
  readonly buildProjection?: (snapshot: SourceSnapshot) => SessionProjection;
  readonly buildScopeProjection?: (projection: SessionProjection) => ScopeProjection;
  readonly buildScopePage?: (scope: ScopeProjection, beforeCursor?: number) => ScopeProjectionPage;
  readonly buildScopeDetail?: (
    projection: SessionProjection,
    startEntryId: string,
    endEntryId: string,
  ) => ScopeDetailProjection;
  readonly validateRange?: (
    snapshot: SourceSnapshot,
    selection: { startEntryId: string; endEntryId: string },
  ) => ValidatedTaskRange;
  readonly buildReport?: (snapshot: SourceSnapshot, range: ValidatedTaskRange) => Promise<TaskEfficiencyReport>;
  readonly buildOverhead?: (snapshot: SourceSnapshot) => Promise<ReviewOverhead>;
  readonly hasReviewMarker?: (sourcePath: string) => Promise<boolean>;
  readonly readReviewEntries?: (ctx: ExtensionContext) => Promise<readonly SessionEntry[]>;
  readonly now?: () => Date;
}

interface RuntimeDependencies {
  readonly listSessions: (cwd: string) => Promise<readonly SessionInfo[]>;
  readonly loadSnapshot: (sourcePath: string) => Promise<SourceSnapshot>;
  readonly buildProjection: (snapshot: SourceSnapshot) => SessionProjection;
  readonly buildScopeProjection: (projection: SessionProjection) => ScopeProjection;
  readonly buildScopePage: (scope: ScopeProjection, beforeCursor?: number) => ScopeProjectionPage;
  readonly buildScopeDetail: (
    projection: SessionProjection,
    startEntryId: string,
    endEntryId: string,
  ) => ScopeDetailProjection;
  readonly validateRange: (
    snapshot: SourceSnapshot,
    selection: { startEntryId: string; endEntryId: string },
  ) => ValidatedTaskRange;
  readonly buildReport: (snapshot: SourceSnapshot, range: ValidatedTaskRange) => Promise<TaskEfficiencyReport>;
  readonly buildOverhead: (snapshot: SourceSnapshot) => Promise<ReviewOverhead>;
  readonly hasReviewMarker: (sourcePath: string) => Promise<boolean>;
  readonly readReviewEntries: (ctx: ExtensionContext) => Promise<readonly SessionEntry[]>;
  readonly now: () => Date;
}

interface ReviewHandoff {
  readonly reviewName: string;
  readonly sourceReference: SourceReference;
  readonly kickoff: string;
}

/** Registers the command, four model-callable operations, and settled overhead recording. */
export function registerTaskEfficiencyExtension(
  pi: ExtensionAPI,
  inputDependencies: TaskEfficiencyExtensionDependencies = {},
): void {
  const dependencies = resolveDependencies(inputDependencies);
  const failedReviewSessions = new WeakSet<object>();
  const recordingReviewSessions = new WeakSet<object>();

  pi.registerCommand("task-efficiency", {
    description: "Create a separate task efficiency review session",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      if (!ctx.hasUI) return;
      if (args.trim().length > 0) {
        ctx.ui.notify("/task-efficiency 不接受参数。", "error");
        return;
      }
      await startReviewSession(ctx, dependencies);
    },
  });

  pi.registerTool({
    name: "task_efficiency_read_scope_page",
    label: "Read Scope Page",
    description: "Read one bounded page of the compact source scope; without arguments returns the newest page, then use previousCursor to read earlier pages. Only valid before a proposal is confirmed.",
    executionMode: "sequential",
    parameters: scopePageSchema,
    execute: async (_toolCallId, parameters, _signal, _onUpdate, ctx) => {
      try {
        return await readScopePage(ctx, parameters, dependencies, failedReviewSessions);
      } catch (error) {
        throw scopePagePublicError(error);
      }
    },
  });

  pi.registerTool({
    name: "task_efficiency_expand_scope",
    label: "Expand Task Scope",
    description: "Read a bounded detailed slice of the source projection only when task boundaries remain ambiguous.",
    executionMode: "sequential",
    parameters: scopeDetailSchema,
    execute: async (_toolCallId, parameters, _signal, _onUpdate, ctx) => {
      try {
        return await expandScope(ctx, parameters, dependencies, failedReviewSessions);
      } catch (error) {
        throw scopeDetailPublicError(error);
      }
    },
  });

  pi.registerTool({
    name: "task_efficiency_propose_scope",
    label: "Propose Task Scope",
    description: "Submit one complete candidate task range for interactive user confirmation.",
    executionMode: "sequential",
    parameters: scopeProposalSchema,
    execute: async (_toolCallId, parameters, _signal, _onUpdate, ctx) => {
      try {
        return await proposeScope(pi, ctx, parameters, dependencies, failedReviewSessions);
      } catch (error) {
        throw proposalPublicError(error);
      }
    },
  });

  pi.registerTool({
    name: "task_efficiency_analyze",
    label: "Analyze Task Efficiency",
    description: "Generate the deterministic report for the latest confirmed task scope.",
    executionMode: "sequential",
    parameters: emptySchema,
    execute: async (_toolCallId, _parameters, _signal, _onUpdate, ctx) => {
      try {
        return await analyzeScope(pi, ctx, dependencies, failedReviewSessions);
      } catch (error) {
        throw analysisPublicError(error);
      }
    },
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await recordReviewOverhead(pi, ctx, dependencies, failedReviewSessions, recordingReviewSessions);
  });
}

async function startReviewSession(ctx: ExtensionCommandContext, dependencies: RuntimeDependencies): Promise<void> {
  const ui = ctx.ui;
  try {
    const sessions = await dependencies.listSessions(ctx.cwd);
    const sourceSessions = await filterSourceSessions(sessions, dependencies.hasReviewMarker);
    if (sourceSessions.length === 0) {
      ui.notify("当前目录没有可复盘的源会话。", "info");
      return;
    }

    const selectedPath = await selectSourceSession(ctx, sourceSessions);
    if (selectedPath === undefined) return;

    let handoff: ReviewHandoff;
    try {
      handoff = await prepareReviewHandoff(selectedPath, dependencies);
    } catch (error) {
      ui.notify(publicError(error, "TASK_EFFICIENCY_SOURCE_UNAVAILABLE").message, "error");
      return;
    }

    const { reviewName, sourceReference, kickoff } = handoff;
    const result = await ctx.newSession({
      setup: async (sessionManager) => {
        sessionManager.appendSessionInfo(reviewName);
        sessionManager.appendCustomEntry(SOURCE_ENTRY_TYPE, sourceReference);
      },
      withSession: async (replacementCtx) => {
        await replacementCtx.sendUserMessage(kickoff, { expandPromptTemplates: true });
      },
    });
    if (result.cancelled) ui.notify("任务效率复盘已取消。", "info");
  } catch (error) {
    try {
      ui.notify(publicError(error, "TASK_EFFICIENCY_INTERNAL").message, "error");
    } catch {
      // A failed UI must not re-expose the original session replacement error.
    }
  }
}

/** Resolves all source-derived state before session replacement and returns only plain durable values. */
async function prepareReviewHandoff(selectedPath: string, dependencies: RuntimeDependencies): Promise<ReviewHandoff> {
  const initial = await dependencies.loadSnapshot(selectedPath);
  const current = await dependencies.loadSnapshot(selectedPath);
  assertSnapshotsMatch(initial, current);
  if (snapshotHasSourceMarker(current)) fail("TASK_EFFICIENCY_SOURCE_UNAVAILABLE");
  const projection = dependencies.buildProjection(current);
  const sourceReference = buildSourceReference(current, projectionDigest(projection));
  return Object.freeze({
    reviewName: `${REVIEW_NAME_PREFIX}${sourceReference.sourceSessionId}`,
    sourceReference: Object.freeze({ ...sourceReference }),
    kickoff: reviewKickoff(),
  });
}

async function readScopePage(
  ctx: ExtensionContext,
  parameters: { beforeCursor?: number },
  dependencies: RuntimeDependencies,
  failedReviewSessions: WeakSet<object>,
) {
  requireUI(ctx);
  assertReviewSessionWritable(ctx, failedReviewSessions);
  const state = await readReviewState(ctx, dependencies);
  if (state.phase !== "empty" && state.phase !== "revised") fail("TASK_EFFICIENCY_SCOPE_PAGE_INVALID");
  const { projection } = await loadFreshSource(state.source, dependencies);
  const scope = dependencies.buildScopeProjection(projection);
  const page = dependencies.buildScopePage(scope, parameters.beforeCursor);
  return toolResult("TASK_EFFICIENCY_SCOPE_PAGE", JSON.stringify(page), {
    totalEntries: page.totalEntries,
    startCursor: page.startCursor,
    endCursor: page.endCursor,
    previousCursor: page.previousCursor,
  });
}

async function expandScope(
  ctx: ExtensionContext,
  parameters: { startEntryId: string; endEntryId: string },
  dependencies: RuntimeDependencies,
  failedReviewSessions: WeakSet<object>,
) {
  requireUI(ctx);
  assertReviewSessionWritable(ctx, failedReviewSessions);
  const state = await readReviewState(ctx, dependencies);
  if (state.phase !== "empty" && state.phase !== "revised") fail("TASK_EFFICIENCY_SCOPE_DETAIL_INVALID");
  const { projection } = await loadFreshSource(state.source, dependencies);
  const detail = dependencies.buildScopeDetail(
    projection,
    parameters.startEntryId.trim(),
    parameters.endEntryId.trim(),
  );
  return toolResult("TASK_EFFICIENCY_SCOPE_DETAIL", JSON.stringify(detail), {
    startEntryId: detail.startEntryId,
    endEntryId: detail.endEntryId,
  });
}

async function proposeScope(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  parameters: ProposalInput,
  dependencies: RuntimeDependencies,
  failedReviewSessions: WeakSet<object>,
) {
  requireUI(ctx);
  assertReviewSessionWritable(ctx, failedReviewSessions);
  const state = await readReviewState(ctx, dependencies);
  const { snapshot } = await loadFreshSource(state.source, dependencies);
  const range = validateProposalRange(snapshot, parameters, dependencies);
  const proposal = createProposal(parameters, snapshot, range, dependencies.now());
  if (classifyProposalPersistence(state, proposal) === "new") {
    appendReviewEntry(pi, ctx, failedReviewSessions, PROPOSAL_ENTRY_TYPE, proposal);
  }

  const selected = await ctx.ui.select(scopeSummary(proposal, range.turns.length), [...scopeActionOptions()]);
  const action = parseScopeAction(selected);
  if (action === "confirm") {
    await confirmProposal(pi, ctx, proposal, dependencies, failedReviewSessions);
    return toolResult("TASK_EFFICIENCY_SCOPE_CONFIRMED", "Scope confirmed. Call task_efficiency_analyze now.", {
      proposalId: proposal.proposalId,
    });
  }
  if (action === "revise") {
    const correction = await ctx.ui.input("修正任务范围", "说明需要调整的边界或内容");
    if (correction === undefined || correction.trim().length === 0) fail("TASK_EFFICIENCY_PROPOSAL_INVALID");
    assertOpenProposal(await readReviewState(ctx, dependencies), proposal);
    const revision = revisionForProposal(proposal.proposalId, correction, dependencies.now());
    appendReviewEntry(pi, ctx, failedReviewSessions, REVISION_ENTRY_TYPE, revision);
    return toolResult(
      "TASK_EFFICIENCY_SCOPE_REVISE",
      `Submit one complete new proposal that incorporates this correction:\n${revision.correction}`,
      { proposalId: proposal.proposalId },
    );
  }

  assertOpenProposal(await readReviewState(ctx, dependencies), proposal);
  appendReviewEntry(
    pi,
    ctx,
    failedReviewSessions,
    TERMINATION_ENTRY_TYPE,
    terminationForProposal(proposal.proposalId, action === "reselect" ? "reselected" : "cancelled", dependencies.now()),
  );
  if (action === "reselect") {
    return toolResult("TASK_EFFICIENCY_SCOPE_RESELECT", "Run /task-efficiency to select another source session.", {
      proposalId: proposal.proposalId,
    }, true);
  }
  return toolResult("TASK_EFFICIENCY_SCOPE_CANCELLED", "Task efficiency review was cancelled.", {
    proposalId: proposal.proposalId,
  }, true);
}

async function confirmProposal(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  proposal: ScopeProposal,
  dependencies: RuntimeDependencies,
  failedReviewSessions: WeakSet<object>,
): Promise<void> {
  const current = await readReviewState(ctx, dependencies);
  assertOpenProposal(current, proposal);
  const { snapshot } = await loadFreshSource(current.source, dependencies);
  restoredProposalRange(snapshot, proposal, dependencies);
  appendReviewEntry(
    pi,
    ctx,
    failedReviewSessions,
    CONFIRMATION_ENTRY_TYPE,
    confirmationForProposal(proposal, dependencies.now()),
  );
}

async function analyzeScope(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  dependencies: RuntimeDependencies,
  failedReviewSessions: WeakSet<object>,
) {
  requireUI(ctx);
  assertReviewSessionWritable(ctx, failedReviewSessions);
  const state = await readReviewState(ctx, dependencies);
  const proposal = state.latestProposal;
  const confirmation = state.latestConfirmation;
  if (state.phase === "reported") fail("TASK_EFFICIENCY_ANALYSIS_NOT_READY");
  if (state.phase !== "confirmed" || proposal === null || confirmation === null) {
    fail("TASK_EFFICIENCY_CONFIRMATION_REQUIRED");
  }
  if (confirmation.proposalId !== proposal.proposalId || confirmation.sourceDigest !== proposal.sourceDigest
    || confirmation.startEntryId !== proposal.startEntryId || confirmation.endEntryId !== proposal.endEntryId) {
    fail("TASK_EFFICIENCY_CONFIRMATION_REQUIRED");
  }

  const { snapshot } = await loadFreshSource(state.source, dependencies);
  const range = restoredProposalRange(snapshot, proposal, dependencies);
  const report = await dependencies.buildReport(snapshot, range);
  const reportJson = JSON.stringify(report);
  appendReviewEntry(
    pi,
    ctx,
    failedReviewSessions,
    REPORT_ENTRY_TYPE,
    compactReportMarker(proposal, reportJson, dependencies.now()),
  );
  return toolResult("TASK_EFFICIENCY_REPORT_READY", reportJson, { proposalId: proposal.proposalId });
}

function validateProposalRange(
  snapshot: SourceSnapshot,
  proposal: ProposalInput,
  dependencies: RuntimeDependencies,
): ValidatedTaskRange {
  const range = dependencies.validateRange(snapshot, proposal);
  assertProposalMatchesRangeValues(proposal, snapshot, range);
  return range;
}

function restoredProposalRange(
  snapshot: SourceSnapshot,
  proposal: ScopeProposal,
  dependencies: RuntimeDependencies,
): ValidatedTaskRange {
  const range = restoredRange(snapshot, proposal, dependencies);
  try {
    assertProposalMatchesRange(proposal, snapshot, range);
  } catch (error) {
    if (error instanceof TaskEfficiencyError && error.code === "TASK_EFFICIENCY_PROPOSAL_INVALID") {
      fail("TASK_EFFICIENCY_ANALYSIS_NOT_READY");
    }
    throw error;
  }
  return range;
}

function restoredRange(
  snapshot: SourceSnapshot,
  proposal: ScopeProposal,
  dependencies: RuntimeDependencies,
): ValidatedTaskRange {
  try {
    return dependencies.validateRange(snapshot, proposal);
  } catch (error) {
    if (error instanceof TaskRangeError) fail("TASK_EFFICIENCY_ANALYSIS_NOT_READY");
    throw error;
  }
}

function assertProposalMatchesRange(proposal: ScopeProposal, snapshot: SourceSnapshot, range: ValidatedTaskRange): void {
  assertProposalSelectionMatchesRange(proposal, snapshot, range);
  const startTimestamp = range.turns[0]?.startTimestamp;
  const endTimestamp = range.turns.at(-1)?.endTimestamp;
  if (proposal.startTimestamp !== startTimestamp || proposal.endTimestamp !== endTimestamp) {
    fail("TASK_EFFICIENCY_PROPOSAL_INVALID");
  }
  if (proposal.sourceDigest !== snapshot.digest) fail("TASK_EFFICIENCY_SOURCE_STALE");
}

function assertProposalMatchesRangeValues(
  proposal: ProposalInput,
  snapshot: SourceSnapshot,
  range: ValidatedTaskRange,
): void {
  assertProposalSelectionMatchesRange(proposal, snapshot, range);
}

function assertProposalSelectionMatchesRange(
  proposal: Pick<ProposalInput, "startEntryId" | "endEntryId" | "evidenceEntryIds">,
  snapshot: SourceSnapshot,
  range: ValidatedTaskRange,
): void {
  const rangeIds = new Set(snapshot.activeBranch.slice(range.startIndex, range.endIndex + 1).map((entry) => entry.id));
  if (proposal.startEntryId.trim() !== range.startEntryId || proposal.endEntryId.trim() !== range.endEntryId
    || proposal.evidenceEntryIds.some((entryId) => !rangeIds.has(entryId.trim()))) {
    fail("TASK_EFFICIENCY_PROPOSAL_INVALID");
  }
}

async function loadFreshSource(
  source: SourceReference,
  dependencies: RuntimeDependencies,
): Promise<{ snapshot: SourceSnapshot; projection: SessionProjection }> {
  let snapshot: SourceSnapshot;
  try {
    snapshot = await dependencies.loadSnapshot(source.sourcePath);
  } catch {
    fail("TASK_EFFICIENCY_SOURCE_UNAVAILABLE");
  }
  const projection = dependencies.buildProjection(snapshot);
  if (snapshot.sourcePath !== source.sourcePath || snapshot.sessionId !== source.sourceSessionId
    || snapshot.digest !== source.sourceDigest || snapshot.activeLeafId !== source.sourceActiveLeafId
    || projectionDigest(projection) !== source.projectionDigest) {
    fail("TASK_EFFICIENCY_SOURCE_STALE");
  }
  return { snapshot, projection };
}

function assertSnapshotsMatch(expected: SourceSnapshot, actual: SourceSnapshot): void {
  if (expected.sourcePath !== actual.sourcePath || expected.sessionId !== actual.sessionId
    || expected.digest !== actual.digest || expected.activeLeafId !== actual.activeLeafId) {
    fail("TASK_EFFICIENCY_SOURCE_STALE");
  }
}

function snapshotHasSourceMarker(snapshot: SourceSnapshot): boolean {
  return snapshot.entries.some((entry) => entry.type === "custom" && entry.raw.customType === SOURCE_ENTRY_TYPE);
}

function reviewKickoff(): string {
  return "/skill:analyze-task-efficiency";
}

function scopePagePublicError(error: unknown): TaskEfficiencyError {
  if (error instanceof ScopePageError) return new TaskEfficiencyError("TASK_EFFICIENCY_SCOPE_PAGE_INVALID");
  return publicError(error, "TASK_EFFICIENCY_INTERNAL");
}

function scopeDetailPublicError(error: unknown): TaskEfficiencyError {
  if (error instanceof ScopeDetailError) return new TaskEfficiencyError("TASK_EFFICIENCY_SCOPE_DETAIL_INVALID");
  return publicError(error, "TASK_EFFICIENCY_INTERNAL");
}

function proposalPublicError(error: unknown): TaskEfficiencyError {
  if (error instanceof TaskRangeError) return new TaskEfficiencyError("TASK_EFFICIENCY_PROPOSAL_INVALID");
  return publicError(error, "TASK_EFFICIENCY_INTERNAL");
}

function analysisPublicError(error: unknown): TaskEfficiencyError {
  if (error instanceof TaskRangeError) return new TaskEfficiencyError("TASK_EFFICIENCY_ANALYSIS_NOT_READY");
  return publicError(error, "TASK_EFFICIENCY_INTERNAL");
}

function requireUI(ctx: ExtensionContext): void {
  if (!ctx.hasUI) fail("TASK_EFFICIENCY_UI_REQUIRED");
}

function assertReviewSessionWritable(ctx: ExtensionContext, failedReviewSessions: WeakSet<object>): void {
  if (failedReviewSessions.has(ctx.sessionManager)) fail("TASK_EFFICIENCY_INTERNAL");
}

function appendReviewEntry(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  failedReviewSessions: WeakSet<object>,
  customType: string,
  data: unknown,
): void {
  try {
    pi.appendEntry(customType, data);
  } catch (error) {
    failedReviewSessions.add(ctx.sessionManager);
    throw error;
  }
}

async function readReviewState(ctx: ExtensionContext, dependencies: RuntimeDependencies): Promise<ReviewState> {
  try {
    return parseReviewState(await dependencies.readReviewEntries(ctx));
  } catch {
    fail("TASK_EFFICIENCY_REVIEW_STATE_INVALID");
  }
}

function classifyProposalPersistence(state: ReviewState, proposal: ScopeProposal): "new" | "resume" {
  if (state.phase === "empty" || state.phase === "revised") return "new";
  if (state.phase === "open" && state.latestProposal?.proposalId === proposal.proposalId) return "resume";
  fail("TASK_EFFICIENCY_REVIEW_STATE_INVALID");
}

function assertOpenProposal(state: ReviewState, proposal: ScopeProposal): void {
  if (classifyProposalPersistence(state, proposal) !== "resume") fail("TASK_EFFICIENCY_REVIEW_STATE_INVALID");
}

async function defaultReadReviewEntries(ctx: ExtensionContext): Promise<readonly SessionEntry[]> {
  const reviewPath = ctx.sessionManager.getSessionFile();
  if (!reviewPath) fail("TASK_EFFICIENCY_REVIEW_STATE_INVALID");
  const snapshot = await loadSourceSnapshot(reviewPath);
  if (snapshot.sessionId !== ctx.sessionManager.getSessionId()) fail("TASK_EFFICIENCY_REVIEW_STATE_INVALID");
  return Object.freeze(snapshot.activeBranch.map((entry) => entry.raw as unknown as SessionEntry));
}

function toolResult(code: string, text: string, details: Record<string, unknown>, terminate = false) {
  return {
    content: [{ type: "text" as const, text }],
    details: { code, ...details },
    ...(terminate ? { terminate: true } : {}),
  };
}

function resolveDependencies(input: TaskEfficiencyExtensionDependencies): RuntimeDependencies {
  return {
    listSessions: input.listSessions ?? ((cwd) => SessionManager.list(cwd)),
    loadSnapshot: input.loadSnapshot ?? loadSourceSnapshot,
    buildProjection: input.buildProjection ?? buildSessionProjection,
    buildScopeProjection: input.buildScopeProjection ?? buildScopeProjection,
    buildScopePage: input.buildScopePage ?? buildScopeProjectionPage,
    buildScopeDetail: input.buildScopeDetail ?? buildScopeDetailProjection,
    validateRange: input.validateRange ?? validateTaskRange,
    buildReport: input.buildReport ?? buildTaskEfficiencyReport,
    buildOverhead: input.buildOverhead ?? buildReviewOverhead,
    hasReviewMarker: input.hasReviewMarker ?? defaultHasReviewMarker,
    readReviewEntries: input.readReviewEntries ?? defaultReadReviewEntries,
    now: input.now ?? (() => new Date()),
  };
}

export { REVIEW_NAME_PREFIX };
