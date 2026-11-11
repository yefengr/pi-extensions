import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentConfigLookup } from "#src/config/agent-types";
import { getSubagentProgress } from "#src/lifecycle/progress";
import { getAgentConversation } from "#src/session/conversation";
import type { PersistedSubagentStore } from "#src/session/persisted-records";
import { type AgentReport, formatAgentReport } from "#src/tools/get-result-report";
import { formatLifetimeTokens, textResult } from "#src/tools/helpers";
import { DEFAULT_RESULT_WAIT_SECONDS, MAX_RESULT_WAIT_SECONDS, waitForAgentResult } from "#src/tools/result-waiter";
import type { Subagent } from "#src/types";
import { formatDuration, getDisplayName } from "#src/ui/display";
import { fileSnapshotSource } from "#src/ui/session-navigation";

// ---- Deps interfaces ----

export interface GetResultToolManager {
	getRecord(id: string): Subagent | undefined;
}

// ---- Class ----

export class GetResultTool {
	constructor(
		private readonly manager: GetResultToolManager,
		private readonly registry: AgentConfigLookup,
		private readonly history?: PersistedSubagentStore,
	) {}

	async execute(
		_toolCallId: string,
		params: { agent_id: string; wait?: boolean; verbose?: boolean; timeout_seconds?: number },
		signal: AbortSignal,
		_onUpdate: unknown,
		_ctx: unknown,
	) {
		const timeout = params.timeout_seconds ?? DEFAULT_RESULT_WAIT_SECONDS;
		if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_RESULT_WAIT_SECONDS) {
			return textResult(`timeout_seconds must be an integer between 1 and ${MAX_RESULT_WAIT_SECONDS}.`);
		}
		const record = this.manager.getRecord(params.agent_id);
		if (!record) return this.persistedResult(params.agent_id, params.verbose);

		// Wait for completion if requested. The record owns the decision of whether
		// it is still awaitable — a queued agent counts, because scheduleVia()
		// captures its limiter promise at spawn. A parent interrupt ends the wait
		// without cancelling the agent, leaving the outcome uncollected below.
		const timedOut = params.wait && record.isActive()
			? await waitForAgentResult(record, timeout, signal) : false;

		// Pull-delivery edge: the parent is collecting the settled outcome here, so
		// mark it consumed. The completion nudge scheduled by onSubagentCompleted
		// re-reads record.consumed at fire time and suppresses itself.
		if (!record.isActive()) {
			record.markConsumed();
		}

		const prefix = timedOut && record.isActive() ? `Wait timed out after ${timeout} seconds; execution continues.\n\n` : "";
		return textResult(prefix + formatAgentReport(this.buildReport(record, params.verbose)));
	}

	private persistedResult(id: string, verbose?: boolean) {
		try {
			const saved = this.history?.get(id);
			if (!saved) return textResult(`Agent not found: "${id}". No record exists on the current parent session branch.`);
			const record = saved.latest;
			let conversation: string | undefined;
			if (verbose && saved.outputFile) {
				try {
					const transcript = this.history!.readTranscript(saved);
					// The native viewer can recover a readable prefix, but a damaged tail
					// must never be presented as a complete conversation.
					for (const line of transcript.trimEnd().split(/\r?\n/)) JSON.parse(line);
					const source = fileSnapshotSource(saved.outputFile, () => transcript);
					conversation = getAgentConversation({ messages: source.getMessages() });
				} catch (error) {
					saved.issues.push(`Transcript incomplete: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			const report: AgentReport = {
				id: record.id, displayName: getDisplayName(record.type, this.registry),
				phase: "terminal", outcome: record.outcome, invocationKind: record.invocationKind, toolUses: record.lifetimeToolUses,
				tokens: formatLifetimeTokens(record), contextPercent: null, compactionCount: 0,
				duration: formatDuration(record.startedAt, record.completedAt), description: record.description,
				result: record.result, error: record.error, stoppedWhileQueued: record.sessionState === "not-created",
				transcriptPath: saved.outputFile, conversation,
			};
			return textResult(formatAgentReport(report) + (saved.issues.length
				? `\n\nHistory incomplete: ${saved.issues.join("; ")}` : ""));
		} catch (error) {
			return textResult(`Cannot read persisted subagent "${id}": ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private buildReport(record: Subagent, verbose?: boolean): AgentReport {
		return {
			id: record.id,
			displayName: getDisplayName(record.type, this.registry),
			phase: record.phase,
			invocationKind: record.lifecycleInvocation.kind,
			...(record.outcome ? { outcome: record.outcome } : {}),
			toolUses: record.toolUses,
			tokens: formatLifetimeTokens(record),
			contextPercent: record.getContextPercent(),
			compactionCount: record.compactionCount,
			duration: formatDuration(record.startedAt, record.completedAt),
			description: record.description,
			result: record.result,
			error: record.error,
			stoppedWhileQueued: record.stoppedWhileQueued,
			conversation: verbose ? record.getConversation() : undefined,
			// Transcript pointer: lets the parent read the full session from disk,
			// and covers verbose after the live session was released (no conversation).
			transcriptPath: record.outputFile,
			progress: getSubagentProgress(record),
		};
	}

	toToolDefinition() {
		return defineTool({
			name: "get_subagent_result" as const,
			label: "Get Agent Result",
			promptSnippet:
				"Check status and retrieve results from a background agent.",
			description:
				"Check status and retrieve results from a background agent. Use the agent ID returned by Agent with run_in_background.",
			parameters: Type.Object({
				agent_id: Type.String({
					description: "The agent ID to check.",
				}),
				wait: Type.Optional(
					Type.Boolean({
						description:
							"If true, wait up to timeout_seconds for completion. A timeout only ends this query. Default: false.",
					}),
				),
				timeout_seconds: Type.Optional(Type.Integer({
					minimum: 1, maximum: MAX_RESULT_WAIT_SECONDS,
					description: `Independent query wait limit in seconds when wait=true. Default ${DEFAULT_RESULT_WAIT_SECONDS}; does not cancel the agent or change its execution budget.`,
				})),
				verbose: Type.Optional(
					Type.Boolean({
						description:
							"If true, include the agent's full conversation (messages + tool calls). Default: false.",
					}),
				),
			}),
			execute: (
				toolCallId: string,
				params: { agent_id: string; wait?: boolean; verbose?: boolean; timeout_seconds?: number },
				signal: AbortSignal,
				onUpdate: unknown,
				ctx: unknown,
			) => this.execute(toolCallId, params, signal, onUpdate, ctx),
		});
	}
}
