import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type KeybindingsConfig,
  type KeybindingsManager,
  type TUI,
  TUI_KEYBINDINGS,
  KeybindingsManager as TuiKeybindingsManager,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { SessionMessage } from "#src/types";
import type { TranscriptSource } from "#src/ui/session-navigation";
import { SessionNavigatorHandler, TranscriptOverlay } from "#src/ui/session-navigator";
import { makeNavigable } from "#test/helpers/make-navigable";
import { fakeSource, mockTui } from "#test/helpers/transcript-fixtures";

const registry = new AgentTypeRegistry(() => new Map());

// Pi's per-entry components read the global interactive theme; Pi initializes it
// at startup before any command runs. Tests must initialize it explicitly.
beforeAll(() => initTheme(undefined, false));

function ansiTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

/** Default keybindings: the overlay routes navigation through the injected registry. */
function defaultKeys(overrides: KeybindingsConfig = {}): KeybindingsManager {
  return new TuiKeybindingsManager(TUI_KEYBINDINGS, overrides);
}

function makeOverlay(
  opts: {
    source?: TranscriptSource;
    done?: (r: undefined) => void;
    tui?: TUI;
    keybindings?: KeybindingsManager;
    outputPad?: number;
  } = {},
) {
  return new TranscriptOverlay({
    tui: opts.tui ?? mockTui(),
    outputPad: opts.outputPad,
    theme: ansiTheme(),
    keybindings: opts.keybindings ?? defaultKeys(),
    source: opts.source ?? fakeSource(),
    done: opts.done ?? vi.fn(),
    cwd: "/test/cwd",
    markdownTheme: getMarkdownTheme(),
  });
}

describe("TranscriptOverlay", () => {
  it("renders the transcript content", () => {
    const lines = makeOverlay().render(80);
    expect(lines.some((l) => l.includes("Hello world"))).toBe(true);
  });

  it("renders Chinese reader chrome separated by horizontal rules", () => {
    const out = makeOverlay().render(80).join("\n");
    expect(out).toContain("子代理会话");
    expect(out).toContain("只读");
    expect(out).toContain("─");
  });

  it("builds its hint line from the injected keybindings", () => {
    const out = makeOverlay({ keybindings: defaultKeys() }).render(80).join("\n");
    expect(out).toContain("↑/↓ 滚动");
    expect(out).toContain("PgUp/PgDn 翻页");
    expect(out).toContain("Esc/Ctrl+C/Q 退出");
  });

  it("reflects remapped bindings in the hint instead of hardcoded keys", () => {
    const keys = defaultKeys({ "tui.select.cancel": "x", "tui.select.up": "y" });
    const out = makeOverlay({ keybindings: keys }).render(80).join("\n");
    expect(out).toContain("Y/↓ 滚动");
    expect(out).toContain("X/Q 退出");
    expect(out).not.toContain("Esc/Q 退出");
  });

  it("closes on the injected cancel binding", () => {
    const done = vi.fn();
    const overlay = makeOverlay({ done, keybindings: defaultKeys({ "tui.select.cancel": "x" }) });
    overlay.handleInput("x");
    expect(done).toHaveBeenCalledWith(undefined);
  });

  it("subscribes on construction and requests a render on change", () => {
    const tui = mockTui();
    let captured: (() => void) | undefined;
    const source = fakeSource({
      subscribe: (onChange) => {
        captured = onChange;
        return () => {};
      },
    });
    makeOverlay({ source, tui });
    captured?.();
    expect(tui.requestRender).toHaveBeenCalledOnce();
  });

  it("closes and calls done on Escape", () => {
    const done = vi.fn();
    const overlay = makeOverlay({ done });
    overlay.handleInput("\x1b");
    expect(done).toHaveBeenCalledWith(undefined);
  });

  it("closes only once — later cancel keys do nothing", () => {
    const done = vi.fn();
    const overlay = makeOverlay({ done });
    overlay.handleInput("\x1b");
    overlay.handleInput("\x1b");
    expect(done).toHaveBeenCalledOnce();
  });

  it("unsubscribes on dispose", () => {
    const unsub = vi.fn();
    const overlay = makeOverlay({ source: fakeSource({ subscribe: () => unsub }) });
    overlay.dispose();
    expect(unsub).toHaveBeenCalledOnce();
  });

  it("does not request a render after dispose", () => {
    const tui = mockTui();
    let captured: (() => void) | undefined;
    const source = fakeSource({
      subscribe: (onChange) => {
        captured = onChange;
        return () => {};
      },
    });
    const overlay = makeOverlay({ source, tui });
    overlay.dispose();
    captured?.();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("appends the streaming-activity indicator while running", () => {
    const source = fakeSource({
      streaming: () => ({ activeTools: new Map([["k", "read"]]), responseText: "" }),
    });
    const out = makeOverlay({ source }).render(80).join("\n");
    expect(out).toContain("◍");
  });

  it("requests a render after a navigation key", () => {
    const tui = mockTui();
    const overlay = makeOverlay({ tui });
    overlay.render(80);
    vi.mocked(tui.requestRender).mockClear();
    overlay.handleInput("\x1b[A");
    expect(tui.requestRender).toHaveBeenCalledOnce();
  });

  it("pages with a remapped page key", () => {
    const tui = mockTui();
    const overlay = makeOverlay({
      tui,
      keybindings: defaultKeys({ "tui.select.pageUp": "ctrl+u" }),
      source: fakeSource({
        getMessages: () => Array.from({ length: 200 }, (_, i) => ({ role: "user", content: `line ${i}` })) as unknown as SessionMessage[],
      }),
    });
    const bottom = overlay.render(80);
    vi.mocked(tui.requestRender).mockClear();
    overlay.handleInput("\x15"); // ctrl+u
    expect(tui.requestRender).toHaveBeenCalledOnce();
    expect(overlay.render(80)).not.toEqual(bottom);
  });

  it("keeps every rendered line inside the compositor width", () => {
    for (const width of [20, 40, 80]) {
      const lines = makeOverlay({ keybindings: defaultKeys({ "tui.select.cancel": "x" }) }).render(width);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("keeps cancel and its action visible at 30, 42 and 80 columns", () => {
    for (const width of [30, 42, 80]) {
      const lines = makeOverlay().render(width);
      expect(lines.at(-1)).toContain("Esc/Ctrl+C/Q 退出");
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it("applies only the outer outputPad and guards widths 0, 1 and 2", () => {
    for (const outputPad of [0, 1]) {
      const overlay = makeOverlay({ outputPad });
      for (const width of [0, 1, 2, 3, 30, 80]) {
        expect(overlay.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
      }
      expect(overlay.render(80)[0].startsWith(`${" ".repeat(outputPad)}子代理会话`)).toBe(true);
    }
  });

  it("uses the same padding-adjusted width before the first paint", () => {
    const source = () => fakeSource({
      getMessages: () => Array.from({ length: 30 }, (_, i) => ({ role: "user", content: `${i} ${"中文wrap".repeat(30)}` })) as unknown as SessionMessage[],
    });
    for (const outputPad of [0, 1]) {
      const beforePaint = makeOverlay({ outputPad, tui: mockTui(40, 80), source: source() });
      const afterPaint = makeOverlay({ outputPad, tui: mockTui(40, 80), source: source() });
      afterPaint.render(72);
      beforePaint.handleInput("\x1b[A");
      afterPaint.handleInput("\x1b[A");
      expect(beforePaint.render(72)).toEqual(afterPaint.render(72));
    }
  });

  it("computes the viewport from the terminal height and shrinks after a resize", () => {
    const tui = mockTui(40, 80);
    const overlay = makeOverlay({ tui });
    const tall = overlay.render(80);
    (tui.terminal as { rows: number }).rows = 12;
    const short = overlay.render(80);
    expect(short.length).toBeLessThan(tall.length);
    expect(short.length).toBeLessThanOrEqual(12);
  });

  it("keeps the exit hint on a terminal too short for the body", () => {
    const done = vi.fn();
    const overlay = makeOverlay({ tui: mockTui(5, 60), done });
    const lines = overlay.render(60);
    const out = lines.join("\n");
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(out).toContain("终端高度不足");
    expect(out).toContain("退出");
    overlay.handleInput("\x1b");
    expect(done).toHaveBeenCalledOnce();
  });

  it("keeps the exit hint on a terminal with no room for a notice", () => {
    const overlay = makeOverlay({ tui: mockTui(2, 60) });
    const lines = overlay.render(60);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("退出");
  });

  it("keeps an exit affordance on a terminal too narrow for the chrome", () => {
    for (const width of [1, 3, 5]) {
      const lines = makeOverlay().render(width);
      expect(lines).toHaveLength(1);
      expect(lines[0].trim()).not.toBe("");
      expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
    }
    // Narrow widths keep a truncated prefix of the cancel hint, never a blank panel.
    expect(makeOverlay().render(5)[0]).toContain("Es");
  });

  it("re-renders identically after invalidate()", () => {
    const overlay = makeOverlay();
    const before = overlay.render(80);
    overlay.invalidate();
    expect(overlay.render(80)).toEqual(before);
  });

  describe("scroll bounds", () => {
    // A 200-column terminal renders the overlay at 90% (180 columns, inner 178)
    // while a layout computed at the terminal width would differ, so a scroll
    // bound derived from the wrong width yields the wrong maxScroll.
    const OVERLAY_WIDTH = 180;
    const wrappingMessages = Array.from({ length: 30 }, (_, i) => ({
      role: "user",
      content: `${String(i).padStart(3, "0")} ${"wrap".repeat(46)}`,
    })) as unknown as SessionMessage[];

    function overlayAtBottom() {
      const overlay = makeOverlay({
        tui: mockTui(40, 200),
        source: fakeSource({ getMessages: () => wrappingMessages }),
      });
      const atBottom = overlay.render(OVERLAY_WIDTH);
      return { overlay, atBottom };
    }

    it("scrolls up from the bottom on a terminal wider than the overlay", () => {
      const { overlay, atBottom } = overlayAtBottom();
      overlay.handleInput("\x1b[A");
      expect(overlay.render(OVERLAY_WIDTH)).not.toEqual(atBottom);
    });

    it("returns to the bottom when scrolling back down", () => {
      const { overlay, atBottom } = overlayAtBottom();
      overlay.handleInput("\x1b[A");
      overlay.handleInput("\x1b[B");
      expect(overlay.render(OVERLAY_WIDTH)).toEqual(atBottom);
    });

    it("keeps the shift+up/down page aliases working", () => {
      const { overlay, atBottom } = overlayAtBottom();
      overlay.handleInput("\x1b[a"); // shift+up
      expect(overlay.render(OVERLAY_WIDTH)).not.toEqual(atBottom);
      overlay.handleInput("\x1b[b"); // shift+down
      expect(overlay.render(OVERLAY_WIDTH)).toEqual(atBottom);
    });

    it("does not follow new content while scrolled up, and resumes at the bottom", () => {
      let messages = [...wrappingMessages];
      const overlay = makeOverlay({
        tui: mockTui(40, 200),
        source: fakeSource({ getMessages: () => messages }),
      });
      const bottom = overlay.render(OVERLAY_WIDTH).join("\n");
      overlay.handleInput("\x1b[A");
      const paused = overlay.render(OVERLAY_WIDTH).join("\n");
      expect(paused).toContain("已暂停跟随");

      messages = [...messages, { role: "user", content: "late message" } as unknown as SessionMessage];
      expect(overlay.render(OVERLAY_WIDTH).join("\n")).toEqual(paused);
      expect(paused).not.toContain("late message");

      overlay.handleInput("\x1b[6~"); // page down past the end
      expect(overlay.render(OVERLAY_WIDTH).join("\n")).not.toEqual(paused);
      expect(bottom).toBeDefined();
    });
  });

  it("refreshes its content when the source changes", () => {
    let messages = [{ role: "user", content: "first" }] as unknown as SessionMessage[];
    let captured: (() => void) | undefined;
    const source = fakeSource({
      getMessages: () => messages,
      subscribe: (onChange) => {
        captured = onChange;
        return () => {};
      },
    });
    const overlay = makeOverlay({ source });
    expect(overlay.render(80).join("\n")).toContain("first");
    messages = [{ role: "user", content: "second" }] as unknown as SessionMessage[];
    captured?.();
    expect(overlay.render(80).join("\n")).toContain("second");
  });
});

describe("SessionNavigatorHandler", () => {
  function makeUI(selectResult?: string) {
    return {
      select: vi.fn().mockResolvedValue(selectResult),
      notify: vi.fn(),
      custom: vi.fn().mockResolvedValue(undefined),
    };
  }

  // Invoke the component factory captured by the handler's ui.custom call and
  // render it — the act (handle) stays explicit in each test.
  function renderCapturedOverlay(ui: ReturnType<typeof makeUI>, width = 80): string[] {
    const factory = ui.custom.mock.calls[0][0] as (
      tui: TUI,
      theme: ReturnType<typeof ansiTheme>,
      kb: KeybindingsManager,
      done: (r: undefined) => void,
    ) => Component;
    const overlay = factory(mockTui(40, 200), ansiTheme(), defaultKeys(), vi.fn());
    return overlay.render(width);
  }

  const noReadFile = (): string => {
    throw new Error("readFile not expected in this test");
  };

  it("notifies and skips the overlay when no sessions are navigable", async () => {
    const ui = makeUI();
    const notReady = makeNavigable({ isSessionReady: () => false, outputFile: undefined });
    await new SessionNavigatorHandler().handle({ ui, agents: [notReady], registry, cwd: "/test/cwd", readFile: noReadFile });
    expect(ui.notify).toHaveBeenCalledWith("暂无可查看的子代理会话。", "info");
    expect(ui.custom).not.toHaveBeenCalled();
  });

  it("does not open the overlay when the operator cancels the picker", async () => {
    const ui = makeUI(undefined);
    await new SessionNavigatorHandler().handle({ ui, agents: [makeNavigable()], registry, cwd: "/test/cwd", readFile: noReadFile });
    expect(ui.select).toHaveBeenCalledOnce();
    expect(ui.custom).not.toHaveBeenCalled();
  });

  it("opens a read-only overlay sourced from the picked record", async () => {
    const messages = [{ role: "assistant", content: [{ type: "text", text: "picked agent reply" }] }] as unknown as SessionMessage[];
    const record = makeNavigable({ agentMessages: messages });
    const [label] = (() => {
      // The handler labels entries identically to listNavigableAgents.
      return [
        "Agent (Test task) · 2 tools · completed · 3.0s",
      ];
    })();
    const ui = makeUI(label);

    await new SessionNavigatorHandler().handle({ ui, agents: [record], registry, cwd: "/test/cwd", readFile: noReadFile });

    expect(ui.custom).toHaveBeenCalledOnce();
    // Invariant #423: the handler is a reactive consumer — it sources the
    // transcript and never reads tool definitions off the record itself; only
    // the overlay does, lazily, through the TranscriptSource at render time.
    expect(record.getToolDefinition).not.toHaveBeenCalled();
    // Invoke the captured component factory and render to confirm it is sourced from the picked record.
    expect(renderCapturedOverlay(ui).some((l) => l.includes("picked agent reply"))).toBe(true);
  });

  it("passes outputPad through the handler to the native transcript shell", async () => {
    for (const outputPad of [0, 1]) {
      const ui = makeUI("Agent (Test task) · 2 tools · completed · 3.0s");
      await new SessionNavigatorHandler().handle({ ui, outputPad, agents: [makeNavigable()], registry, cwd: "/test/cwd", readFile: noReadFile });
      expect(renderCapturedOverlay(ui)[0].startsWith(`${" ".repeat(outputPad)}子代理会话`)).toBe(true);
    }
  });

  it("opens the reader overlay at 90% width with an 85% height cap and margin", async () => {
    const ui = makeUI("Agent (Test task) · 2 tools · completed · 3.0s");
    await new SessionNavigatorHandler().handle({ ui, agents: [makeNavigable()], registry, cwd: "/test/cwd", readFile: noReadFile });
    const options = ui.custom.mock.calls[0][1] as {
      overlay: boolean;
      overlayOptions: { width: string; maxHeight: string; margin: number };
    };
    expect(options.overlay).toBe(true);
    expect(options.overlayOptions.width).toBe("90%");
    expect(options.overlayOptions.maxHeight).toBe("85%");
    expect(options.overlayOptions.margin).toBe(1);
  });

  it("opens an overlay sourced from the persisted file when a released agent is picked", async () => {
    const jsonl = [
      { type: "session", version: 3, id: "s1", timestamp: "2026-06-23T00:00:00Z", cwd: "/proj" },
      { type: "message", id: "m1", parentId: null, timestamp: "2026-06-23T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "released reply" }] } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    const readFile = vi.fn(() => jsonl);
    const released = makeNavigable({
      id: "e1", description: "Old task", phase: "terminal", outcome: "completed", startedAt: 1000, completedAt: 4000, toolUses: 5,
      isSessionReady: () => false, outputFile: "/tasks/e1.jsonl",
    });
    const ui = makeUI("Agent (Old task) · 5 tools · completed · 3.0s · session released (snapshot)");

    await new SessionNavigatorHandler().handle({ ui, agents: [released], registry, cwd: "/test/cwd", readFile });

    expect(readFile).toHaveBeenCalledWith("/tasks/e1.jsonl");
    expect(ui.custom).toHaveBeenCalledOnce();
    expect(renderCapturedOverlay(ui).some((l) => l.includes("released reply"))).toBe(true);
  });

  it("notifies and skips the overlay when the session file cannot be read", async () => {
    const readFile = vi.fn(() => {
      throw new Error("ENOENT");
    });
    const released = makeNavigable({
      id: "e1", description: "Old task", phase: "terminal", outcome: "completed", startedAt: 1000, completedAt: 4000, toolUses: 5,
      isSessionReady: () => false, outputFile: "/tasks/e1.jsonl",
    });
    const ui = makeUI("Agent (Old task) · 5 tools · completed · 3.0s · session released (snapshot)");

    await new SessionNavigatorHandler().handle({ ui, agents: [released], registry, cwd: "/test/cwd", readFile });

    expect(ui.notify).toHaveBeenCalledWith("无法读取该会话的对话记录文件。", "error");
    expect(ui.custom).not.toHaveBeenCalled();
  });
});
