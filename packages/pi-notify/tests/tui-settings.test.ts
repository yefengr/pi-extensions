import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type Keybinding, KeybindingsManager, TUI_KEYBINDINGS, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { installTuiSourceLoader } from "./helpers/tui-source-loader.ts";

installTuiSourceLoader();

const { NotifySettingsOverlay } = await import("../src/tui/settings-overlay.ts");
const { RecapModelSelectorOverlay } = await import("../src/tui/recap-model-selector.ts");
const { loadConfig, resolveConfigPath } = await import("../src/settings.ts");
type PanelTheme = import("../src/ui.ts").PanelTheme;
type ModelOption = import("../src/tui/model-picker.ts").ModelOption;

const MODELS: ModelOption[] = [
  { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
  { provider: "google", id: "gemini-flash", name: "Gemini Flash" },
  { provider: "deepseek", id: "deepseek-flash", name: "DeepSeek Flash" },
  { provider: "mistral", id: "mistral-large", name: "Mistral Large" },
];

interface ThemeCodes {
  accent: number;
  text: number;
  muted: number;
  dim: number;
  borderMuted: number;
  success: number;
  warning: number;
  error: number;
}

const DARK_CODES: ThemeCodes = {
  accent: 36,
  text: 37,
  muted: 90,
  dim: 2,
  borderMuted: 38,
  success: 32,
  warning: 33,
  error: 31,
};

function makeTheme(codes: ThemeCodes): PanelTheme {
  const fg = (token: string, text: string): string => {
    const code = (codes as unknown as Record<string, number>)[token] ?? 39;
    return `\u001b[${code}m${text}\u001b[0m`;
  };
  const bold = (text: string): string => `\u001b[1m${text}\u001b[0m`;
  return { fg, bold } as unknown as Theme;
}


const RAW_KEYS: Partial<Record<Keybinding, string>> = {
  "tui.select.confirm": "\r",
  "tui.select.cancel": "\x1b",
  "tui.select.up": "\x1b[A",
  "tui.select.down": "\x1b[B",
  "tui.select.pageUp": "\x1b[5~",
  "tui.select.pageDown": "\x1b[6~",
};

/** 剥离 ANSI 与光标标记，仅用于文案断言。 */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_pi:[^ \x07]*\x07/g, "");
}

/** 用真实终端序列驱动，并断言该序列确实命中注入的键位。 */
function rawKey(keybindings: KeybindingsManager, binding: Keybinding): string {
  const raw = RAW_KEYS[binding];
  assert.ok(raw !== undefined, `no raw sequence for ${binding}`);
  assert.ok(keybindings.matches(raw, binding), `raw sequence does not match ${binding}`);
  return raw;
}

function withTempAgentDir(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "pi-notify-tui-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    run(directory);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

interface Fixture {
  overlay: InstanceType<typeof NotifySettingsOverlay>;
  keybindings: KeybindingsManager;
  press: (binding: Keybinding, repeat?: number) => void;
  text: (width?: number) => string;
}

function createSettingsFixture(options: { budget?: () => number; models?: ModelOption[]; theme?: PanelTheme; outputPad?: number } = {}): Fixture {
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  setKeybindings(keybindings);
  const overlay = new NotifySettingsOverlay({
    models: options.models ?? MODELS,
    keybindings,
    theme: options.theme ?? makeTheme(DARK_CODES),
    getRows: options.budget ?? (() => 24),
    outputPad: options.outputPad,
  });
  return {
    overlay,
    keybindings,
    press: (binding, repeat = 1) => {
      const raw = rawKey(keybindings, binding);
      for (let index = 0; index < repeat; index++) overlay.handleInput(raw);
    },
    text: (width = 70) => overlay.render(width).join("\n"),
  };
}

function expectWithinWidth(overlay: InstanceType<typeof NotifySettingsOverlay>, width: number): void {
  for (const line of overlay.render(width)) {
    assert.ok(visibleWidth(line) <= width, `line exceeds ${width} columns: ${JSON.stringify(line)}`);
  }
}

describe("notify settings overlay", () => {
  it("keeps toggle changes in the draft and never writes on open", () => {
    withTempAgentDir(() => {
      const fixture = createSettingsFixture();
      assert.match(fixture.text(), /已启用/);
      assert.equal(existsSync(resolveConfigPath()), false);

      fixture.press("tui.select.confirm");

      const rendered = fixture.text();
      assert.match(rendered, /已关闭/);
      assert.match(rendered, /草稿未保存/);
      assert.equal(loadConfig().enabled, true);
      assert.equal(existsSync(resolveConfigPath()), false);
    });
  });

  it("cancels without persisting the draft", () => {
    withTempAgentDir(() => {
      const fixture = createSettingsFixture();
      let closed = 0;
      fixture.overlay.onClose = () => {
        closed += 1;
      };
      fixture.press("tui.select.confirm");
      fixture.press("tui.select.cancel");
      assert.equal(closed, 1);
      assert.equal(loadConfig().enabled, true);
      assert.equal(existsSync(resolveConfigPath()), false);
    });
  });

  it("writes the draft from the dedicated save item reached by paging", () => {
    withTempAgentDir(() => {
      const fixture = createSettingsFixture({ budget: () => 24 });
      fixture.press("tui.select.confirm");
      fixture.press("tui.select.pageDown");
      fixture.press("tui.select.confirm");

      const rendered = fixture.text();
      assert.match(rendered, /设置已保存到 notify\.json/);
      assert.match(rendered, /与磁盘一致/);
      assert.equal(loadConfig().enabled, false);
    });
  });

  it("pages by the real visible rows instead of the full item count", () => {
    withTempAgentDir(() => {
      const fixture = createSettingsFixture({ budget: () => 11 });
      fixture.press("tui.select.pageDown");
      fixture.press("tui.select.confirm");

      const rendered = fixture.text();
      // 预算 11 时可见 5 行：PgDn 移到第 6 项 session_shutdown，而不是保存项。
      assert.match(stripAnsi(rendered), /会话结束\s+已启用/);
      assert.match(stripAnsi(rendered), /写入配置文件/);
      assert.match(stripAnsi(rendered), /草稿未保存/);
      assert.equal(existsSync(resolveConfigPath()), false);
    });
  });

  it("keeps the same selection id when the budget changes", () => {
    withTempAgentDir(() => {
      let budget = 24;
      const fixture = createSettingsFixture({ budget: () => budget });
      fixture.press("tui.select.down", 2);
      fixture.text(60);

      budget = 11;
      fixture.text(60);
      fixture.press("tui.select.confirm");
      assert.match(fixture.text(60), /Recap 模型选择/);
    });
  });

  it("wraps up/down like the native list", () => {
    withTempAgentDir(() => {
      const fixture = createSettingsFixture({ budget: () => 24 });
      fixture.press("tui.select.up");
      fixture.press("tui.select.confirm");
      // 顶部向上 wrap 到最后一项「保存设置」。
      assert.match(fixture.text(), /设置已保存到 notify\.json/);
      assert.equal(existsSync(resolveConfigPath()), true);
    });
  });

  it("blocks confirm, navigation and save on a short screen", () => {
    withTempAgentDir(() => {
      let budget = 8;
      const fixture = createSettingsFixture({ budget: () => budget });
      const rendered = fixture.text(50);
      assert.match(rendered, /终端高度不足/);
      assert.match(rendered, /取消/);
      assert.doesNotMatch(rendered, /保存设置/);

      fixture.press("tui.select.confirm");
      fixture.press("tui.select.down");
      fixture.press("tui.select.pageDown");
      assert.equal(existsSync(resolveConfigPath()), false);

      budget = 24;
      const restored = fixture.text();
      assert.match(restored, /已启用/);
      assert.doesNotMatch(restored, /草稿未保存/);
      assert.equal(existsSync(resolveConfigPath()), false);
    });
  });

  it("degrades the hint to cancel on narrow widths", () => {
    withTempAgentDir(() => {
      const fixture = createSettingsFixture();
      const rendered = fixture.text(28);
      assert.match(rendered, /取消/);
      assert.doesNotMatch(rendered, /翻页/);
      expectWithinWidth(fixture.overlay, 28);
    });
  });

  it("keeps the draft and reports errors when the config cannot be written", () => {
    withTempAgentDir(() => {
      mkdirSync(resolveConfigPath(), { recursive: true });
      const fixture = createSettingsFixture();
      fixture.press("tui.select.confirm");
      fixture.press("tui.select.pageDown");
      fixture.press("tui.select.confirm");

      const rendered = fixture.text();
      assert.match(rendered, /保存失败/);
      assert.match(rendered, /已关闭/);
      assert.match(rendered, /草稿未保存/);
    });
  });

  it("edits the recap model only inside the draft sub page", () => {
    withTempAgentDir(() => {
      const fixture = createSettingsFixture();
      fixture.press("tui.select.down", 2);
      fixture.press("tui.select.confirm");
      assert.match(fixture.text(), /Recap 模型选择/);
      assert.match(fixture.text(), /Claude Sonnet/);

      for (const char of "gpt") fixture.overlay.handleInput(char);
      assert.match(fixture.text(), /GPT-4o/);
      fixture.press("tui.select.confirm");

      const rendered = fixture.text();
      assert.match(rendered, /通知设置/);
      assert.match(rendered, /草稿：模型改为 openai\/gpt-4o/);
      assert.equal(loadConfig().recap.model, null);
    });
  });

  it("returns from the model sub page without touching the draft on cancel", () => {
    withTempAgentDir(() => {
      const fixture = createSettingsFixture();
      fixture.press("tui.select.down", 2);
      fixture.press("tui.select.confirm");
      fixture.press("tui.select.cancel");

      const rendered = fixture.text();
      assert.match(rendered, /通知设置/);
      assert.match(stripAnsi(rendered), /Recap 模型\s+未选择/);
      assert.equal(loadConfig().recap.model, null);
    });
  });

  it("pages the model list by visible rows and keeps a valid selection", () => {
    withTempAgentDir(() => {
      const fixture = createSettingsFixture({ budget: () => 12 });
      fixture.press("tui.select.down", 2);
      fixture.press("tui.select.confirm");
      fixture.press("tui.select.pageDown");

      // 5 个模型全部可见，PgDn 从首项跳到末项。
      fixture.press("tui.select.confirm");
      assert.match(fixture.text(), /草稿：模型改为 mistral\/mistral-large/);

      fixture.press("tui.select.confirm");
      for (const char of "zzz") fixture.overlay.handleInput(char);
      fixture.press("tui.select.confirm");
      assert.match(fixture.text(), /没有匹配的模型/);
      assert.equal(loadConfig().recap.model, null);
    });
  });

  it("propagates focus to the model input and accepts Chinese, emoji and pasted text", () => {
    withTempAgentDir(() => {
      const fixture = createSettingsFixture();
      fixture.press("tui.select.down", 2);
      fixture.press("tui.select.confirm");
      fixture.overlay.focused = true;
      assert.match(fixture.text(), new RegExp(CURSOR_MARKER));

      fixture.overlay.handleInput("中文🙂粘贴");
      fixture.press("tui.select.confirm");
      const rendered = fixture.text();
      assert.match(rendered, /中文🙂粘贴/);
      assert.match(rendered, /没有匹配的模型/);
      expectWithinWidth(fixture.overlay, 40);
    });
  });

  it("does not focus the hidden search input on a short screen", () => {
    withTempAgentDir(() => {
      let budget = 24;
      const fixture = createSettingsFixture({ budget: () => budget });
      fixture.press("tui.select.down", 2);
      fixture.press("tui.select.confirm");
      fixture.overlay.focused = true;
      assert.match(fixture.text(), new RegExp(CURSOR_MARKER));

      budget = 8;
      const rendered = fixture.text();
      assert.doesNotMatch(rendered, new RegExp(CURSOR_MARKER));
      assert.match(rendered, /终端高度不足/);
    });
  });

  it("repaints with the new theme after invalidate", () => {
    withTempAgentDir(() => {
      const fixture = createSettingsFixture();
      assert.match(fixture.text(), /\u001b\[36m/);

      const light = makeTheme({ ...DARK_CODES, accent: 35, borderMuted: 91 });
      fixture.overlay.setTheme(light);
      fixture.overlay.invalidate();
      const rendered = fixture.text();
      assert.match(rendered, /\u001b\[35m/);
      assert.doesNotMatch(rendered, /\u001b\[36m/);
    });
  });

  it("never renders more rows than the effective overlay budget", () => {
    withTempAgentDir(() => {
      for (const budget of [8, 10, 11, 13, 24]) {
        const fixture = createSettingsFixture({ budget: () => budget });
        const lines = fixture.overlay.render(70);
        assert.ok(lines.length <= budget, `settings panel rendered ${lines.length} rows for budget ${budget}`);
      }
      let budget = 24;
      const fixture = createSettingsFixture({ budget: () => budget });
      fixture.press("tui.select.down", 2);
      fixture.press("tui.select.confirm");
      for (const candidate of [10, 11, 12, 8, 24]) {
        budget = candidate;
        const lines = fixture.overlay.render(70);
        assert.ok(lines.length <= candidate, `model panel rendered ${lines.length} rows for budget ${candidate}`);
      }
    });
  });

  it("never renders wider than the requested columns", () => {
    withTempAgentDir(() => {
      const fixture = createSettingsFixture();
      expectWithinWidth(fixture.overlay, 20);
      expectWithinWidth(fixture.overlay, 30);
      expectWithinWidth(fixture.overlay, 120);
    });
  });

  it("keeps exit visible and blocks saves on budgets 0..3", () => {
    withTempAgentDir(() => {
      for (const budget of [0, 1, 2, 3]) {
        const fixture = createSettingsFixture({ budget: () => budget });
        const lines = fixture.overlay.render(70);
        assert.ok(lines.length <= budget, `预算 ${budget} 渲染了 ${lines.length} 行`);
        if (budget >= 1) assert.match(stripAnsi(lines.join("\n")), /取消/);
        fixture.press("tui.select.confirm");
        fixture.press("tui.select.pageDown");
        fixture.press("tui.select.confirm");
      }
      assert.equal(existsSync(resolveConfigPath()), false);
      assert.equal(loadConfig().enabled, true);
    });
  });

  it("never overflows at widths 1 and 2 with either padding mode", () => {
    withTempAgentDir(() => {
      for (const outputPad of [0, 1] as const) {
        for (const width of [1, 2, 30]) {
          const fixture = createSettingsFixture({ outputPad });
          for (const line of fixture.overlay.render(width)) {
            assert.ok(visibleWidth(line) <= width, `pad ${outputPad} width ${width} 行宽 ${visibleWidth(line)}`);
          }
        }
      }
    });
  });
});

describe("notify recap model overlay", () => {
  it("persists the confirmed model immediately", () => {
    withTempAgentDir(() => {
      const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
      setKeybindings(keybindings);
      const overlay = new RecapModelSelectorOverlay(MODELS, {
        keybindings,
        theme: makeTheme(DARK_CODES),
        getRows: () => 24,
      });
      assert.match(overlay.render(70).join("\n"), /确认后立即写入/);

      overlay.handleInput("g");
      overlay.handleInput("p");
      overlay.handleInput("t");
      overlay.handleInput(rawKey(keybindings, "tui.select.confirm"));

      const rendered = overlay.render(70).join("\n");
      assert.match(rendered, /模型已保存：openai\/gpt-4o/);
      assert.equal(loadConfig().recap.model, "openai/gpt-4o");
    });
  });

  it("reports an empty selection instead of crashing", () => {
    withTempAgentDir(() => {
      const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
      setKeybindings(keybindings);
      const overlay = new RecapModelSelectorOverlay([], {
        keybindings,
        theme: makeTheme(DARK_CODES),
        getRows: () => 24,
      });
      overlay.handleInput(rawKey(keybindings, "tui.select.confirm"));
      assert.match(overlay.render(70).join("\n"), /没有匹配的模型/);
      assert.equal(loadConfig().recap.model, null);
    });
  });

  it("propagates focus to the standalone recap native input", () => {
    withTempAgentDir(() => {
      const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
      setKeybindings(keybindings);
      const overlay = new RecapModelSelectorOverlay(MODELS, {
        keybindings,
        theme: makeTheme(DARK_CODES),
        getRows: () => 24,
      });
      overlay.focused = true;
      assert.match(overlay.render(70).join("\n"), new RegExp(CURSOR_MARKER));
      overlay.focused = false;
      assert.doesNotMatch(overlay.render(70).join("\n"), new RegExp(CURSOR_MARKER));
    });
  });
});
