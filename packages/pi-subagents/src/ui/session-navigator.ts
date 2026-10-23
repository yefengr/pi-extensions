/**
 * session-navigator.ts — The `/subagents:sessions` command: pick a subagent and
 * read its transcript through Pi's own per-entry session components.
 *
 * SDK/TUI consumer half of native session navigation. The unit-testable core
 * (selection, sourcing) lives in `session-navigation.ts`; this module wires that
 * core to the command picker and a read-only scrollable overlay, and owns the
 * renderer — it mounts Pi's interactive components (`AssistantMessageComponent`,
 * `ToolExecutionComponent`, …) into a `Container`, mirroring Pi's own
 * `renderSessionContext` mapping. Rendering lives here, not in the pure module,
 * because the components require a `TUI`, `cwd`, and markdown theme.
 *
 * The overlay is strictly read-only — steering stays in the `steer_subagent` tool
 * and the widget. It consumes a `TranscriptSource`, so a released agent's disk
 * snapshot (`fileSnapshotSource`) swaps in without touching the renderer or the overlay.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type KeybindingsManager,
  type KeyId,
  type MarkdownTheme,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { AgentConfigLookup } from "#src/config/agent-types";
import type { Theme } from "#src/ui/display";
import { fileSnapshotSource, listNavigableAgents, liveSource, type NavigableSubagent, type TranscriptSource } from "#src/ui/session-navigation";
import { TranscriptContent } from "#src/ui/transcript-content";

// ─────────────────────────────────────────────────────────────────────────────

/** Chrome lines painted around the body: title + two separators + footer. */
const CHROME_LINES = 4;
/** Smallest body the reader keeps before it degrades to a short-screen notice. */
const MIN_VIEWPORT = 3;
/** Narrowest panel width the reader paints; below it only the exit affordance fits. */
const MIN_RENDER_WIDTH = 6;
/** Reader panel: 90% width, 85% height, one row/column of margin (TUI guidelines). */
const READER_WIDTH_PCT = 90;
const READER_HEIGHT_PCT = 85;
const READER_MARGIN = 1;

/** Display labels for the key ids Pi reports from the keybinding registry. */
const KEY_LABELS: Record<string, string> = {
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  pageUp: "PgUp",
  pageDown: "PgDn",
  home: "Home",
  end: "End",
  escape: "Esc",
  enter: "Enter",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
};

/** Render one key id (`ctrl+c`, `pageUp`, …) as a short human label. */
function keyLabel(key: KeyId): string {
  return key
    .split("+")
    .map((part) => {
      const label = KEY_LABELS[part];
      if (label) return label;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("+");
}

/** Lay `right` against the right edge of `width`, dropping it when it cannot fit. */
function joinSides(left: string, right: string, width: number): string {
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);
  if (leftWidth + rightWidth + 2 > width) return left;
  return left + " ".repeat(width - leftWidth - rightWidth) + right;
}

/** Component factory shape Pi's `ui.custom` invokes to mount an overlay. */
export type OverlayComponentFactory<R> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: R) => void,
) => Component;

/** Narrow UI interface — only the `ctx.ui` methods the navigator calls. */
export interface SessionNavigatorUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
  custom<R>(component: OverlayComponentFactory<R>, options?: unknown): Promise<R>;
}

/** Parameters for one `/subagents:sessions` invocation. */
export interface SessionNavigatorParams {
  ui: SessionNavigatorUI;
  outputPad?: number;
  agents: readonly NavigableSubagent[];
  registry: AgentConfigLookup;
  /** Working directory for tool-call rendering (relative path display). */
  cwd: string;
  /** Reads a persisted session file for the file-snapshot source. */
  readFile: (path: string) => string;
}

/** Options for the read-only transcript overlay. */
export interface TranscriptOverlayOptions {
  tui: TUI;
  theme: Theme;
  /** Injected registry — navigation and cancel must follow the user's bindings. */
  keybindings: KeybindingsManager;
  source: TranscriptSource;
  done: (result: undefined) => void;
  cwd: string;
  markdownTheme: MarkdownTheme;
  outputPad?: number;
}

/**
 * Handler for the `/subagents:sessions` slash command.
 *
 * Lists navigable subagents, lets the operator pick one, and opens its transcript
 * read-only. Receives the agent snapshot (`manager.listAgents()`) rather than the
 * manager, so it stays a reactive consumer with no inbound call into the core.
 */
export class SessionNavigatorHandler {
  async handle({ ui, agents, registry, cwd, readFile, outputPad = 1 }: SessionNavigatorParams): Promise<void> {
    const entries = listNavigableAgents(agents, registry);
    if (entries.length === 0) {
      ui.notify("暂无可查看的子代理会话。", "info");
      return;
    }

    const choice = await ui.select(
      "子代理会话",
      entries.map((entry) => entry.label),
    );
    const entry = entries.find((candidate) => candidate.label === choice);
    if (!entry) return;

    let source: TranscriptSource;
    try {
      source = entry.kind === "live" ? liveSource(entry.record) : fileSnapshotSource(entry.outputFile, readFile);
    } catch {
      ui.notify("无法读取该会话的对话记录文件。", "error");
      return;
    }
    const markdownTheme = getMarkdownTheme();
    await ui.custom<undefined>(
      (tui, theme, keybindings, done) =>
        new TranscriptOverlay({ tui, theme, keybindings, source, done, cwd, markdownTheme, outputPad }),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: `${READER_WIDTH_PCT}%`,
          maxHeight: `${READER_HEIGHT_PCT}%`,
          margin: READER_MARGIN,
        },
      },
    );
  }
}

/**
 * Read-only scrollable transcript overlay.
 *
 * Owns scroll state, chrome, and key handling; the rows it paints come from a
 * `TranscriptContent` collaborator, which holds the transcript's components and
 * refreshes them when the source changes (live agents).
 */
export class TranscriptOverlay implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private closed = false;

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly done: (result: undefined) => void;
  private readonly content: TranscriptContent;
  private readonly outputPad: number;
  /** Inner width the compositor last rendered at; input must use the same layout. */
  private renderedInnerWidth: number | undefined;

  constructor({ tui, theme, keybindings, source, done, cwd, markdownTheme, outputPad = 1 }: TranscriptOverlayOptions) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    this.outputPad = outputPad;
    this.content = new TranscriptContent({ tui, cwd, markdownTheme, source });
    this.unsubscribe = source.subscribe((event) => {
      if (this.closed) return;
      this.content.apply(event);
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    if (this.closed) return;

    if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "q")) {
      this.close();
      return;
    }

    const totalLines = this.content.lineCount(this.inputWidth());
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);
    // Scroll from the line actually on screen: while following live output the
    // stored offset is stale, so an up/down pair would end one line off the tail.
    const base = this.autoScroll ? maxScroll : Math.min(this.scrollOffset, maxScroll);

    let next: number;
    if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) {
      next = Math.max(0, base - 1);
    } else if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) {
      next = Math.min(maxScroll, base + 1);
    } else if (this.keybindings.matches(data, "tui.select.pageUp") || matchesKey(data, "shift+up")) {
      next = Math.max(0, base - viewportHeight);
    } else if (this.keybindings.matches(data, "tui.select.pageDown") || matchesKey(data, "shift+down")) {
      next = Math.min(maxScroll, base + viewportHeight);
    } else if (matchesKey(data, "home")) {
      next = 0;
    } else if (matchesKey(data, "end")) {
      next = maxScroll;
    } else {
      return;
    }

    this.scrollOffset = next;
    // Follow live output only while the reader sits at the bottom.
    this.autoScroll = next >= maxScroll;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const th = this.theme;
    const padding = this.padding(width);
    const innerW = Math.max(1, width - padding * 2);
    this.renderedInnerWidth = innerW;
    if (width <= 0) return [];

    // Too narrow for the chrome: paint the exit affordance instead of a blank panel.
    if (width < MIN_RENDER_WIDTH) {
      return [truncateToWidth(th.fg("dim", `${this.cancelHint()} 退出`), width)];
    }

    const pad = (s: string, len: number): string => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const row = (content: string): string => truncateToWidth(
      " ".repeat(padding) + truncateToWidth(pad(content, innerW), innerW) + " ".repeat(padding), width,
    );
    const separator = th.fg("borderMuted", "─".repeat(width));

    // Read-only layout: the compositor's width/height fully determine the viewport.
    const totalLines = this.content.lineCount(innerW);
    const availableRows = this.availableRows();
    const lines: string[] = [];
    const status = th.fg("muted", `${totalLines} 行 · 只读`);
    lines.push(row(joinSides(th.fg("accent", th.bold("子代理会话")), status, innerW)));
    lines.push(separator);

    if (this.isCompact(availableRows)) {
      // The height cap truncates from the tail, so the exit keys go first: they
      // survive any short terminal, the notice follows, the title is expendable.
      const compact = [
        row(th.fg("dim", `按 ${this.cancelHint()} 退出`)),
        row(th.fg("warning", "终端高度不足，无法显示会话内容")),
        row(th.fg("accent", th.bold("子代理会话"))),
      ];
      return compact.slice(0, availableRows);
    }

    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);
    const visibleStart = this.autoScroll ? maxScroll : Math.min(this.scrollOffset, maxScroll);
    const visible = this.content.slice(innerW, visibleStart, viewportHeight);
    for (let i = 0; i < viewportHeight; i++) lines.push(row(visible[i] ?? ""));

    lines.push(separator);
    const pct =
      totalLines <= viewportHeight
        ? "100%"
        : `${Math.round(((visibleStart + viewportHeight) / totalLines) * 100)}%`;
    const feedback = `${visibleStart > 0 ? `第 ${visibleStart + 1} 行` : "顶部"} · ${pct}${this.autoScroll ? "" : " · 已暂停跟随"}`;
    lines.push(row(th.fg("dim", this.footerLine(innerW, feedback))));

    return lines;
  }

  // fallow-ignore-next-line unused-class-member
  invalidate(): void {
    this.content.invalidate();
  }

  dispose(): void {
    this.closed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // ---- Private ----

  /** End once: a closed overlay ignores later input and late source events. */
  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.done(undefined);
  }

  /** Bound keys for one action, formatted for the hint line. */
  private keysOf(keybinding: "tui.select.up" | "tui.select.down" | "tui.select.pageUp" | "tui.select.pageDown" | "tui.select.cancel"): string {
    const keys = this.keybindings.getKeys(keybinding);
    return keys.length === 0 ? "—" : keys.map(keyLabel).join("/");
  }

  private cancelHint(): string {
    return `${this.keysOf("tui.select.cancel")}/Q`;
  }

  /** Footer hint built from the injected bindings, never a hardcoded key list. */
  private footerLine(width: number, feedback: string): string {
    let footer = `${this.cancelHint()} 退出`;
    const extras = [
      `${this.keysOf("tui.select.up")}/${this.keysOf("tui.select.down")} 滚动`,
      `${this.keysOf("tui.select.pageUp")}/${this.keysOf("tui.select.pageDown")} 翻页`,
      "Home/End 首尾",
      feedback,
    ];
    for (const extra of extras) {
      const candidate = `${footer} · ${extra}`;
      if (visibleWidth(candidate) <= width) footer = candidate;
    }
    return footer;
  }

  private padding(width: number): number {
    return Math.min(Math.max(0, Math.floor(this.outputPad)), Math.max(0, Math.floor((width - 1) / 2)));
  }

  /**
   * Rows the overlay can actually paint: the reader share of the terminal,
   * further limited by the compositor margin.
   */
  private availableRows(): number {
    const { rows } = this.tui.terminal;
    const capped = Math.floor((rows * READER_HEIGHT_PCT) / 100);
    return Math.max(1, Math.min(capped, rows - READER_MARGIN * 2));
  }

  private isCompact(availableRows: number): boolean {
    return availableRows - CHROME_LINES < MIN_VIEWPORT;
  }

  private viewportHeight(): number {
    return Math.max(MIN_VIEWPORT, this.availableRows() - CHROME_LINES);
  }

  /**
   * The width `handleInput` must lay out at: the one the compositor actually
   * supplied, so scroll bounds match the layout on screen. Before the first
   * paint there is none, so fall back to the overlay's share of the terminal.
   */
  private inputWidth(): number {
    const width = Math.max(0, Math.min(
      Math.floor((this.tui.terminal.columns * READER_WIDTH_PCT) / 100),
      this.tui.terminal.columns - READER_MARGIN * 2,
    ));
    return this.renderedInnerWidth ?? Math.max(1, width - this.padding(width) * 2);
  }
}
