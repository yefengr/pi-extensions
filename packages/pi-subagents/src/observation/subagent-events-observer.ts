import { readFileSync } from "node:fs";
import {
	buildLifecycleEventData,
	buildLifecycleRecord,
} from "#src/lifecycle/lifecycle-record";
import type { SubagentManagerObserver } from "#src/lifecycle/subagent-manager";
import type { NotificationSystem } from "#src/observation/notification";
import type { HistoryParent } from "#src/session/persisted-records";
import type { CompactionInfo, Subagent } from "#src/types";

/** Emit callback — a subset of `pi.events.emit`. */
export type EventEmit = (channel: string, data: unknown) => void;

/** Append callback — a subset of `pi.appendEntry`. */
export type AppendEntry = (customType: string, data: unknown) => void;

export interface SubagentEventsObserverDeps {
	emit: EventEmit;
	appendEntry: AppendEntry;
	notifications: NotificationSystem;
	getParent?: () => HistoryParent | undefined;
}

/**
 * Receives agent lifecycle notifications from SubagentManager and dispatches
 * them to three concerns: pi.events lifecycle events, session-entry persistence,
 * and completion notifications.
 *
 * Constructed with narrow deps (emit, appendEntry, NotificationSystem) so all
 * three concerns are unit-testable without booting the extension.
 */
export class SubagentEventsObserver implements SubagentManagerObserver {
	private readonly emit: EventEmit;
	private readonly appendEntry: AppendEntry;
	private readonly getParent?: () => HistoryParent | undefined;
	private readonly notifications: NotificationSystem;

	constructor(deps: SubagentEventsObserverDeps) {
		this.emit = deps.emit;
		this.appendEntry = deps.appendEntry;
		this.getParent = deps.getParent;
		this.notifications = deps.notifications;
	}

	onSubagentStarted(record: Subagent): void {
		this.emit("subagents:started", buildLifecycleEventData(record));
	}

	onSubagentCompleted(record: Subagent): void {
		this.persistTerminal(
			record,
			record.isTerminalError() ? "subagents:failed" : "subagents:completed",
		);
	}

	onSubagentResumed(record: Subagent): void {
		this.persistTerminal(record, "subagents:resumed");
	}

	/** Public terminal event and persisted custom entry share one exact v3 object. */
	private persistTerminal(record: Subagent, eventName: string): void {
		const data = buildLifecycleRecord(record);
		this.emit(eventName, data);
		const parent = this.getParent?.();
		const original = record.parentSession;
		if (this.getParent && (!parent || parent.id !== original?.parentSessionId || parent.file !== original.parentSessionFile)) return;
		this.appendEntry("subagents:record", data);
		if (parent) {
			const matches = this.getParent?.()?.entries.filter((entry): entry is { id: string; data: unknown } => {
				if (!entry || typeof entry !== "object") return false;
				const value = entry as { type?: string; customType?: string; id?: string; data?: unknown };
				return value.type === "custom" && value.customType === "subagents:record" && typeof value.id === "string"
					&& JSON.stringify(value.data) === JSON.stringify(data);
			}) ?? [];
			if (matches.length === 1 && record.sessionId && persistedTerminal(parent, matches[0]!.id, data)) {
				const terminalEntryId = matches[0]!.id;
				record.recordTerminalReceipt({
					parentId: parent.id, parentFile: parent.file, terminalEntryId,
					agentId: record.id, agentType: record.type, childSessionId: record.sessionId,
					invocationIndex: record.invocationIndex,
					isCurrent: () => {
						const current = this.getParent?.();
						return current?.id === parent.id && current.file === parent.file
							&& persistedTerminal(current, terminalEntryId, data)
							&& current.entries.some((entry) => !!entry && typeof entry === "object"
								&& (entry as { id?: string }).id === terminalEntryId);
					},
				});
			}
		}
		if (record.isBackground) this.notifications.sendCompletion(record);
	}

	onSubagentCompacted(record: Subagent, info: CompactionInfo): void {
		this.emit("subagents:compacted", {
			...buildLifecycleEventData(record),
			reason: info.reason,
			tokensBefore: info.tokensBefore,
			compactionCount: record.compactionCount,
		});
	}

	onSubagentCreated(record: Subagent): void {
		this.emit("subagents:created", buildLifecycleEventData(record));
	}
}

/** SDK custom entries may still be memory-only before the first assistant message. */
function persistedTerminal(parent: HistoryParent, id: string, data: unknown): boolean {
	try {
		const [header, ...entries] = readFileSync(parent.file, "utf8").trimEnd().split(/\r?\n/).map((line) => JSON.parse(line));
		return header?.type === "session" && header.id === parent.id && entries.some((entry) =>
			entry?.type === "custom" && entry.customType === "subagents:record" && entry.id === id
			&& JSON.stringify(entry.data) === JSON.stringify(data));
	} catch { return false; }
}
