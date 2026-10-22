/**
 * result-renderer.ts — Pure per-phase/outcome rendering functions for Agent tool results.
 *
 * All functions are stateless: they receive AgentDetails and a Theme, returning
 * formatted strings. No SDK types, no timers, no side effects.
 * Consumed by the renderResult hook in agent-tool.ts.
 */

import type { AgentDetails, Theme } from "#src/ui/display";
import { formatMs, formatTurns, getOutcomeLabel } from "#src/ui/display";
import { GLYPHS, SPINNER } from "#src/ui/glyphs";

// ---- Dispatcher ----

/** Dispatch on details.phase/outcome; isPartial forces the running view. */
export function renderAgentResult(
	details: AgentDetails,
	resultText: string,
	expanded: boolean,
	isPartial: boolean,
	theme: Theme,
): string {
	if (isPartial || details.phase === "running" || details.phase === "queued") {
		return renderRunning(details, theme);
	}
	if (details.phase === "background") return renderBackground(details, theme);
	if (details.phase === "terminal" && details.outcome === "completed") {
		return renderCompleted(details, resultText, expanded, theme);
	}
	return renderFailed(details, theme);
}

// ---- Per-phase renderers ----

/** Render running/queued/partial status: spinner + stats + activity line. */
export function renderRunning(details: AgentDetails, theme: Theme): string {
	const frame = SPINNER[details.spinnerFrame ?? 0];
	const s = renderStats(details, theme);
	let line = theme.fg("accent", frame) + (s ? " " + s : "");
	line += "\n" + theme.fg("dim", `  ${GLYPHS.subLine}  ${details.activity ?? "thinking\u2026"}`);
	return line;
}

/** Render background launch status. */
export function renderBackground(details: AgentDetails, theme: Theme): string {
	return theme.fg("dim", `  ${GLYPHS.subLine}  Running in background (ID: ${details.agentId})`);
}

/** Render the completed outcome with optional expanded result text. */
export function renderCompleted(
	details: AgentDetails,
	resultText: string,
	expanded: boolean,
	theme: Theme,
): string {
	const duration = formatMs(details.durationMs);
	const s = renderStats(details, theme);
	let line = theme.fg("success", GLYPHS.success) + (s ? " " + s : "");
	line += " " + theme.fg("dim", "\u00B7") + " " + theme.fg("dim", duration);

	if (expanded) {
		if (resultText) {
			const lines = resultText.split("\n").slice(0, 50);
			for (const l of lines) {
				line += "\n" + theme.fg("dim", `  ${l}`);
			}
			if (resultText.split("\n").length > 50) {
				line +=
					"\n" +
					theme.fg(
						"muted",
						"  ... (use get_subagent_result with verbose for full output)",
					);
			}
		}
	} else {
		line += "\n" + theme.fg("dim", `  ${GLYPHS.subLine}  Done`);
	}
	return line;
}

/**
 * Render every non-completed terminal outcome with failure styling.
 * `error` carries the failure message; the other outcomes show their frozen label.
 */
export function renderFailed(details: AgentDetails, theme: Theme): string {
	const s = renderStats(details, theme);
	let line = theme.fg("error", GLYPHS.failure) + (s ? " " + s : "");

	if (details.outcome === "error") {
		line +=
			"\n" +
			theme.fg("error", `  ${GLYPHS.subLine}  Error: ${details.error ?? "unknown"}`);
	} else {
		line +=
			"\n" +
			theme.fg("warning", `  ${GLYPHS.subLine}  ${getOutcomeLabel(details.outcome)}`);
	}
	return line;
}

// ---- Shared helper ----

/**
 * Build the stats string: "haiku · thinking: high · ↻5≤30 · 3 tool uses · 33.8k token".
 * Returns an empty string when all fields are absent or zero.
 */
export function renderStats(details: AgentDetails, theme: Theme): string {
	const parts: string[] = [];
	if (details.modelName) parts.push(details.modelName);
	if (details.tags) parts.push(...details.tags);
	if (details.invocationTurnCount != null && details.invocationTurnCount > 0) {
		parts.push(formatTurns(details.invocationTurnCount, details.maxTurns));
	}
	if (details.toolUses > 0)
		parts.push(`${details.toolUses} tool use${details.toolUses === 1 ? "" : "s"}`);
	if (details.tokens) parts.push(details.tokens);
	return parts
		.map((p) => theme.fg("dim", p))
		.join(" " + theme.fg("dim", "\u00B7") + " ");
}
