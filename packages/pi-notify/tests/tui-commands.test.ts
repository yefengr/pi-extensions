import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { installTuiSourceLoader } from "./helpers/tui-source-loader.ts";

installTuiSourceLoader();

const { NOTIFY_COMMANDS, registerNotifyCommands } = await import("../src/commands.ts");
const { loadConfig, resolveConfigPath } = await import("../src/settings.ts");
type PanelTheme = import("../src/ui.ts").PanelTheme;

const MODELS = [
  { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
];

const THEME = {
  fg: (token: string, text: string) => `\u001b[${token === "accent" ? 36 : 37}m${text}\u001b[0m`,
  bold: (text: string) => `\u001b[1m${text}\u001b[0m`,
} as unknown as PanelTheme & Theme;

interface Harness {
  run: (command: string) => Promise<void>;
  notes: { message: string; level: string }[];
  customCalls: number;
  registryCalls: number;
  doneCalls: number;
  renderCalls: number;
  component: (Component & { focused?: boolean }) | null;
}

function createHarness(mode: "tui" | "rpc" | "print", options: { rows?: number; outputPad?: number } = {}): Harness {
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  setKeybindings(keybindings);
  const handlers = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const pi = {
    registerCommand: (name: string, definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
      handlers.set(name, definition);
    },
    getSettings: () => ({ outputPad: options.outputPad ?? 1 }),
  } as unknown as ExtensionAPI;
  registerNotifyCommands(pi);

  const harness: Harness = {
    run: async (command) => {
      const registration = handlers.get(command);
      assert.ok(registration, `command ${command} is registered`);
      await registration.handler("", ctx);
    },
    notes: [],
    customCalls: 0,
    registryCalls: 0,
    doneCalls: 0,
    renderCalls: 0,
    component: null,
  };

  const tui = {
    requestRender() {
      assert.equal(this, tui, "requestRender must retain its TUI receiver");
      harness.renderCalls += 1;
    },
    terminal: { rows: options.rows ?? 30 },
  };
  const ctx = {
    mode,
    hasUI: true,
    settingsManager: {
      getSettings: () => ({ outputPad: 1 }),
    },
    modelRegistry: {
      getAvailable: () => {
        harness.registryCalls += 1;
        return MODELS;
      },
    },
    ui: {
      notify: (message: string, level = "info") => {
        harness.notes.push({ message, level });
      },
      custom: (factory: (...args: unknown[]) => Component) => {
        harness.customCalls += 1;
        harness.component = factory(tui, THEME, keybindings, () => {
          harness.doneCalls += 1;
        });
        return Promise.resolve(undefined);
      },
    },
  } as unknown as ExtensionContext;

  return harness;
}

function pressCancel(harness: Harness): void {
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  setKeybindings(keybindings);
  const raw = "\x1b";
  assert.ok(keybindings.matches(raw, "tui.select.cancel"), "raw escape matches the injected binding");
  assert.ok(harness.component);
  harness.component.handleInput?.(raw);
}

function withTempAgentDir(run: () => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "pi-notify-commands-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  return run().finally(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
}

describe("notify commands and TUI mode guards", () => {
  it("does not create a custom overlay outside the TUI", async () => {
    for (const mode of ["rpc", "print"] as const) {
      const harness = createHarness(mode);
      await withTempAgentDir(async () => {
        await harness.run(NOTIFY_COMMANDS.SETTINGS);
        await harness.run(NOTIFY_COMMANDS.RECAP_MODEL);
      });
      assert.equal(harness.customCalls, 0);
      assert.equal(harness.registryCalls, 0);
      assert.equal(harness.notes.length, 2);
      assert.equal(harness.notes[0]!.level, "warning");
      assert.match(harness.notes[0]!.message, /交互式 TUI/);
    }
  });

  it("opens the settings panel in the TUI without writes, notifications or registry refreshes", async () => {
    const harness = createHarness("tui");
    await withTempAgentDir(async () => {
      await harness.run(NOTIFY_COMMANDS.SETTINGS);
      assert.equal(harness.customCalls, 1);
      // 只取一次可用模型，不产生模型目录刷新。
      assert.equal(harness.registryCalls, 1);
      assert.equal(harness.notes.length, 0);
      assert.equal(existsSync(resolveConfigPath()), false);
      assert.ok(harness.component);
      assert.match(harness.component!.render(70).join("\n"), /通知设置/);
    });
  });

  it("finishes the settings overlay exactly once on cancel", async () => {
    const harness = createHarness("tui");
    await withTempAgentDir(async () => {
      await harness.run(NOTIFY_COMMANDS.SETTINGS);
      pressCancel(harness);
      pressCancel(harness);
      assert.equal(harness.doneCalls, 1);
      assert.equal(loadConfig().enabled, true);
    });
  });

  it("opens the standalone recap model panel from the command", async () => {
    const harness = createHarness("tui");
    await withTempAgentDir(async () => {
      await harness.run(NOTIFY_COMMANDS.RECAP_MODEL);
      assert.equal(harness.customCalls, 1);
      assert.equal(harness.registryCalls, 1);
      assert.match(harness.component!.render(70).join("\n"), /Recap 模型选择/);
      pressCancel(harness);
      assert.equal(harness.doneCalls, 1);
      assert.equal(existsSync(resolveConfigPath()), false);
    });
  });

  it("derives the overlay budget from the injected tui terminal rows", async () => {
    const short = createHarness("tui", { rows: 6 });
    await withTempAgentDir(async () => {
      await short.run(NOTIFY_COMMANDS.SETTINGS);
      const lines = short.component!.render(70);
      // rows 6 => 预算 4，与 process.stdout 无关；短屏必须保留退出提示。
      assert.ok(lines.length <= 4, `短屏渲染 ${lines.length} 行超过预算`);
      assert.match(lines.join("\n"), /终端高度不足/);
      assert.match(lines.join("\n"), /取消/);
    });

    const tall = createHarness("tui", { rows: 30 });
    await withTempAgentDir(async () => {
      await tall.run(NOTIFY_COMMANDS.RECAP_MODEL);
      const lines = tall.component!.render(70);
      assert.doesNotMatch(lines.join("\n"), /终端高度不足/);
      assert.ok(lines.length <= 22, `rows 30 的预算为 22：${lines.length}`);
    });
  });

  it("applies outputPad from settings around the unified shell", async () => {
    for (const outputPad of [1, 0] as const) {
      const harness = createHarness("tui", { rows: 30, outputPad });
      await withTempAgentDir(async () => {
        await harness.run(NOTIFY_COMMANDS.SETTINGS);
        const lines = harness.component!.render(40);
        assert.ok(lines.length > 0);
        for (const line of lines) {
          assert.ok(visibleWidth(line) <= 40, `行宽 ${visibleWidth(line)} 超过 40`);
          if (outputPad === 1) assert.ok(line.startsWith(" ") && line.endsWith(" "), `缺少外壳留白：${JSON.stringify(line)}`);
        }
        if (outputPad === 0) assert.ok(!lines[0]!.startsWith(" "), "padding 0 不应额外缩进标题");
      });
    }
  });

  for (const command of [NOTIFY_COMMANDS.SETTINGS, NOTIFY_COMMANDS.RECAP_MODEL]) {
    it(`preserves the TUI render receiver for ${command} input and cancel`, async () => {
      const harness = createHarness("tui");
      await withTempAgentDir(async () => {
        await harness.run(command);
        assert.ok(harness.component?.handleInput);
        harness.component.focused = true;
        harness.component.render(70);

        const beforeInput = harness.renderCalls;
        assert.doesNotThrow(() => harness.component!.handleInput!("\x1b[B"));
        assert.ok(harness.renderCalls > beforeInput, "navigation requests a render on the TUI instance");

        const beforeCancel = harness.renderCalls;
        assert.doesNotThrow(() => pressCancel(harness));
        assert.ok(harness.renderCalls > beforeCancel, "cancel preserves the render receiver");
        assert.equal(harness.doneCalls, 1);
        assert.equal(existsSync(resolveConfigPath()), false);
        assert.equal(harness.notes.length, 0);
        assert.equal(harness.registryCalls, 1);
      });
    });
  }

  it("propagates focus to the standalone recap model input", async () => {
    const harness = createHarness("tui", { rows: 30 });
    await withTempAgentDir(async () => {
      await harness.run(NOTIFY_COMMANDS.RECAP_MODEL);
      assert.ok(harness.component);
      harness.component.focused = true;
      assert.match(harness.component.render(70).join("\n"), new RegExp(CURSOR_MARKER));
      harness.component.focused = false;
      assert.doesNotMatch(harness.component.render(70).join("\n"), new RegExp(CURSOR_MARKER));
    });
  });
});
