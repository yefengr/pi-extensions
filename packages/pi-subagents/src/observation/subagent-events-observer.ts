import {
	buildLifecycleEventData,
	buildLifecycleRecord,
} from "#src/lifecycle/lifecycle-record";
import type { SubagentManagerObserver } from "#src/lifecycle/subagent-manager";
import type { NotificationSystem } from "#src/observation/notification";
import type { CompactionInfo, Subagent } from "#src/types";

/** Emit callback — a subset of `pi.events.emit`. */
export type EventEmit = (channel: string, data: unknown) => void;

/** Append callback — a subset of `pi.appendEntry`. */
export type AppendEntry = (customType: string, data: unknown) => void;

export interface SubagentEventsObserverDeps {
	emit: EventEmit;
	appendEntry: AppendEntry;
	notifications: NotificationSystem;
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
	private readonly notifications: NotificationSystem;

	constructor(deps: SubagentEventsObserverDeps) {
		this.emit = deps.emit;
		this.appendEntry = deps.appendEntry;
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

	/** Public terminal event and persisted custom entry share one exact v2 object. */
	private persistTerminal(record: Subagent, eventName: string): void {
		const data = buildLifecycleRecord(record);
		this.emit(eventName, data);
		this.appendEntry("subagents:record", data);
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
