import { describe, expect, it } from "vitest";
import type { NotificationDetails } from "#src/observation/notification";
import {
  buildPreviewLines,
  buildStatsParts,
  createNotificationRenderer,
  resolveStatusPresentation,
} from "#src/observation/renderer";

function stubTheme() {
  return {
    fg: (style: string, text: string) => `[${style}:${text}]`,
    bold: (text: string) => `**${text}**`,
  };
}

function makeDetails(overrides: Partial<NotificationDetails> = {}): NotificationDetails {
  return {
    id: "agent-1",
    description: "Test agent",
    phase: "terminal",
    outcome: "completed",
    toolUses: 3,
    invocationTurnCount: 5,
    lifetimeTurnCount: 5,
    maxTurns: 10,
    totalTokens: 1000,
    durationMs: 5000,
    resultPreview: "All done.",
    ...overrides,
  };
}

function renderText(result: ReturnType<ReturnType<typeof createNotificationRenderer>>): string {
  expect(result).toBeDefined();
  return result!.render(120).join("\n");
}

describe("resolveStatusPresentation", () => {
  it("renders a completed terminal outcome as success", () => {
    expect(resolveStatusPresentation("terminal", "completed")).toEqual({
      iconGlyph: "✓",
      iconStyle: "success",
      statusText: "Done",
    });
  });

  it("renders non-completed terminal outcomes as errors", () => {
    expect(resolveStatusPresentation("terminal", "timeout")).toEqual({
      iconGlyph: "✗",
      iconStyle: "error",
      statusText: "Timed out",
    });
  });

  it("uses the phase while an outcome is not available", () => {
    expect(resolveStatusPresentation("queued", undefined)).toEqual({
      iconGlyph: "●",
      iconStyle: "dim",
      statusText: "queued",
    });
  });

  it("includes an error message for error outcomes", () => {
    expect(resolveStatusPresentation("terminal", "error", "boom").statusText).toBe("Error: boom");
  });
});

describe("buildStatsParts", () => {
  it("includes invocation turns, tool uses, tokens, and duration", () => {
    expect(buildStatsParts({
      invocationTurnCount: 5,
      maxTurns: 10,
      toolUses: 3,
      totalTokens: 1000,
      durationMs: 5000,
    })).toEqual(["↻5≤10", "3 tool uses", "1.0k token", "5.0s"]);
  });

  it("omits zero-value stats", () => {
    expect(buildStatsParts({
      invocationTurnCount: 0,
      maxTurns: 10,
      toolUses: 0,
      totalTokens: 0,
      durationMs: 0,
    })).toEqual([]);
  });

  it("pluralizes tool uses", () => {
    expect(buildStatsParts({
      invocationTurnCount: 0,
      maxTurns: 10,
      toolUses: 1,
      totalTokens: 0,
      durationMs: 0,
    })).toEqual(["1 tool use"]);
  });
});

describe("buildPreviewLines", () => {
  it("shows only a capped first line when collapsed", () => {
    const long = "x".repeat(100);
    expect(buildPreviewLines(`${long}\nsecond`, false)).toEqual([long.slice(0, 80)]);
  });

  it("caps expanded previews at 30 lines", () => {
    const lines = Array.from({ length: 35 }, (_, index) => `line${index}`);
    expect(buildPreviewLines(lines.join("\n"), true)).toEqual(lines.slice(0, 30));
  });
});

describe("createNotificationRenderer", () => {
  it("returns undefined without details", () => {
    const renderer = createNotificationRenderer();
    expect(renderer({ details: undefined }, { expanded: false }, stubTheme())).toBeUndefined();
  });

  it("renders a completed terminal record", () => {
    const renderer = createNotificationRenderer();
    const text = renderText(renderer({ details: makeDetails() }, { expanded: false }, stubTheme()));
    expect(text).toContain("[success:✓]");
    expect(text).toContain("**Test agent**");
    expect(text).toContain("Done");
    expect(text).toContain("↻5≤10");
  });

  it("renders a failed terminal record", () => {
    const renderer = createNotificationRenderer();
    const text = renderText(renderer(
      { details: makeDetails({ outcome: "error", error: "boom" }) },
      { expanded: false },
      stubTheme(),
    ));
    expect(text).toContain("[error:✗]");
    expect(text).toContain("Error: boom");
  });

  it("renders the complete preview only when expanded", () => {
    const renderer = createNotificationRenderer();
    const expanded = renderText(renderer(
      { details: makeDetails({ resultPreview: "line1\nline2" }) },
      { expanded: true },
      stubTheme(),
    ));
    expect(expanded).toContain("line1");
    expect(expanded).toContain("line2");

    const collapsed = renderText(renderer(
      { details: makeDetails({ resultPreview: "line1\nline2" }) },
      { expanded: false },
      stubTheme(),
    ));
    expect(collapsed).toContain("line1");
    expect(collapsed).not.toContain("line2");
  });

  it("renders the transcript pointer when available", () => {
    const renderer = createNotificationRenderer();
    const text = renderText(renderer(
      { details: makeDetails({ outputFile: "/tmp/transcript.jsonl" }) },
      { expanded: false },
      stubTheme(),
    ));
    expect(text).toContain("/tmp/transcript.jsonl");
  });
});
