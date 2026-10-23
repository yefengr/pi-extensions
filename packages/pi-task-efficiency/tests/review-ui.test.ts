import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionCommandContext, SessionInfo } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";

import {
  filterSessionCandidates,
  formatSessionLabel,
  MAX_VISIBLE_SESSIONS,
  MIN_SELECTOR_ROWS,
  overlayRowBudget,
  SearchableSessionSelector,
  selectSourceSession,
  SESSION_SELECTOR_OVERLAY_OPTIONS,
  sessionListCapacity,
  type SessionSelectorKeybindings,
  type SessionSelectorTheme,
} from "../src/extension/review-ui.ts";

const BASE_TIME = Date.parse("2026-09-07T00:00:00.000Z");
const WIDTH = 120;
/** 测试默认终端高度：扣掉面板固定行数后足够显示 10 行候选。 */
const DEFAULT_TERMINAL_ROWS = 24;

const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_PAGE_UP = "\x1b[5~";
const KEY_PAGE_DOWN = "\x1b[6~";
const KEY_ENTER = "\r";
const KEY_ESCAPE = "\x1b";

const THEME: SessionSelectorTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

const KEYBINDINGS: SessionSelectorKeybindings = new KeybindingsManager(TUI_KEYBINDINGS);

function sessionInfo(index: number, overrides: Partial<SessionInfo> = {}): SessionInfo {
  const suffix = String(index).padStart(2, "0");
  return {
    path: `/sessions/session-${suffix}.jsonl`,
    id: `session-id-${suffix}-full`,
    cwd: "/workspace/current",
    name: `会话 ${suffix}`,
    created: new Date(BASE_TIME - index * 60_000),
    modified: new Date(BASE_TIME - index * 60_000),
    messageCount: index + 1,
    firstMessage: `第一条消息 ${suffix}`,
    allMessagesText: `第一条消息 ${suffix}`,
    ...overrides,
  };
}

function sessions(count: number): readonly SessionInfo[] {
  return Array.from({ length: count }, (_value, index) => sessionInfo(index));
}

interface SelectorHarnessOptions {
  readonly rows?: () => number;
  readonly outputPad?: number;
  readonly theme?: SessionSelectorTheme;
  readonly keybindings?: SessionSelectorKeybindings;
}

function buildSelector(
  candidates: readonly SessionInfo[],
  drive?: (component: SearchableSessionSelector) => void,
  options: SelectorHarnessOptions = {},
) {
  let selected: string | undefined;
  let cancelled = false;
  const component = new SearchableSessionSelector({
    sessions: candidates,
    outputPad: options.outputPad,
    theme: options.theme ?? THEME,
    keybindings: options.keybindings ?? KEYBINDINGS,
    rowsProvider: options.rows ?? (() => DEFAULT_TERMINAL_ROWS),
    onChange: () => {},
    onSelect: (path) => { selected = path; },
    onCancel: () => { cancelled = true; },
  });
  drive?.(component);
  return {
    component,
    selectedPath: () => selected,
    isCancelled: () => cancelled,
  };
};

function candidateLines(lines: readonly string[]): readonly string[] {
  return lines.filter((line) => /\d+\. 会话 \d{2}/.test(line));
}

interface TuiContextHarness {
  readonly context: ExtensionCommandContext;
  /** ctx.ui.custom 收到的第二个参数（覆盖层配置）。 */
  readonly customOptions: () => unknown;
}

function tuiContext(drive: (component: SearchableSessionSelector) => void): TuiContextHarness {
  let customOptions: unknown;
  const context = {
    mode: "tui",
    ui: {
      select: async () => {
        throw new Error("TUI 模式不应回退到 ctx.ui.select");
      },
      custom: async (factory: unknown, options?: unknown) => new Promise<unknown>((resolve) => {
        customOptions = options;
        const create = factory as (
          tui: { requestRender: () => void; terminal: { rows: number } },
          theme: SessionSelectorTheme,
          keybindings: SessionSelectorKeybindings,
          done: (value: string | null) => void,
        ) => SearchableSessionSelector;
        const component = create(
          { requestRender: () => {}, terminal: { rows: DEFAULT_TERMINAL_ROWS } },
          THEME,
          KEYBINDINGS,
          resolve as (value: string | null) => void,
        );
        drive(component);
      }),
    },
  } as unknown as ExtensionCommandContext;
  return { context, customOptions: () => customOptions };
}

test("选择器一次最多渲染 10 条候选并显示位置/总数", () => {
  const { component } = buildSelector(sessions(25));
  const lines = component.render(WIDTH);
  const rows = lines.filter((line) => /\d+\. 会话 \d{2}/.test(line));

  assert.equal(MAX_VISIBLE_SESSIONS, 10);
  assert.equal(rows.length, MAX_VISIBLE_SESSIONS);
  assert.ok(rows.every((line) => visibleWidth(line) <= WIDTH));

  const output = lines.join("\n");
  assert.match(output, /位置 1\/25/);
  assert.match(output, /1\. 会话 00/);
  assert.match(output, /10\. 会话 09/);
  assert.ok(!output.includes("11. 会话 10"));
});

test("上下键与翻页键按输入顺序选择正确的会话 path", () => {
  const candidates = sessions(25);

  const single = buildSelector(candidates, (component) => {
    component.handleInput(KEY_DOWN);
    component.handleInput(KEY_ENTER);
  });
  assert.equal(single.selectedPath(), candidates[1]!.path);

  const page = buildSelector(candidates, (component) => {
    component.handleInput(KEY_PAGE_DOWN);
    component.handleInput(KEY_ENTER);
  });
  assert.equal(page.selectedPath(), candidates[10]!.path);

  const paged = buildSelector(candidates, (component) => {
    component.handleInput(KEY_PAGE_DOWN);
    component.handleInput(KEY_PAGE_DOWN);
    const output = component.render(WIDTH).join("\n");
    assert.match(output, /位置 21\/25/);
    assert.match(output, /> 21\. 会话 20/);
    assert.ok(!output.includes("1. 会话 00"));
    component.handleInput(KEY_UP);
    component.handleInput(KEY_ENTER);
  });
  assert.equal(paged.selectedPath(), candidates[19]!.path);

  const pagedUp = buildSelector(candidates, (component) => {
    component.handleInput(KEY_PAGE_DOWN);
    component.handleInput(KEY_PAGE_DOWN);
    component.handleInput(KEY_PAGE_UP);
    component.handleInput(KEY_ENTER);
  });
  assert.equal(pagedUp.selectedPath(), candidates[10]!.path);
});

test("搜索覆盖 name、firstMessage 与完整 id，大小写不敏感且多词 AND 匹配", () => {
  const named = sessionInfo(1, { name: "Beta rollout", firstMessage: "unrelated" });
  const described = sessionInfo(2, { name: undefined, firstMessage: "Implement beta cache" });
  const identified = sessionInfo(3, { name: "other", firstMessage: "unrelated", id: "session-xyz-beta-id" });
  const candidates = [sessionInfo(0), named, described, identified];

  assert.deepEqual(filterSessionCandidates(candidates, "BETA").map((session) => session.path), [
    named.path,
    described.path,
    identified.path,
  ]);
  assert.deepEqual(filterSessionCandidates(candidates, "beta cache").map((session) => session.path), [described.path]);
  assert.deepEqual(filterSessionCandidates(candidates, "xyz").map((session) => session.path), [identified.path]);
  assert.equal(filterSessionCandidates(candidates, "   ").length, candidates.length);

  const { selectedPath } = buildSelector(candidates, (component) => {
    for (const character of "beta cache") component.handleInput(character);
    assert.match(component.render(WIDTH).join("\n"), /筛选 1\/4/);
    component.handleInput(KEY_ENTER);
  });
  assert.equal(selectedPath(), described.path);
});

test("重复标题时选择器返回正确会话的 path 且标签带唯一短 id", () => {
  const first = sessionInfo(1, { name: "同名会话", firstMessage: "same", id: "dup-aaaa-1111" });
  const second = sessionInfo(2, { name: "同名会话", firstMessage: "same", id: "dup-bbbb-2222" });

  const { component, selectedPath } = buildSelector([first, second], (instance) => {
    instance.handleInput(KEY_DOWN);
    instance.handleInput(KEY_ENTER);
  });
  assert.equal(selectedPath(), second.path);

  const output = component.render(WIDTH).join("\n");
  assert.match(output, /1\. 同名会话 · .*dup-aaaa/);
  assert.match(output, /2\. 同名会话 · .*dup-bbbb/);
});

test("非 TUI 模式沿用 ctx.ui.select 并在重复标题下返回正确会话 path", async () => {
  const first = sessionInfo(1, { name: "同名会话", firstMessage: "same", id: "dup-aaaa-1111" });
  const second = sessionInfo(2, { name: "同名会话", firstMessage: "same", id: "dup-bbbb-2222" });
  const candidates = [first, second];
  const options: string[][] = [];
  let customCalls = 0;
  const context = {
    mode: "rpc",
    ui: {
      custom: async () => {
        customCalls += 1;
        return null;
      },
      select: async (_title: string, values: string[]) => {
        options.push(values);
        return values[1];
      },
    },
  } as unknown as ExtensionCommandContext;

  const selected = await selectSourceSession(context, candidates);
  assert.equal(selected, second.path);
  assert.equal(customCalls, 0);
  assert.equal(options.length, 1);
  assert.deepEqual(options[0], candidates.map((session, index) => formatSessionLabel(session, index)));
});

test("TUI 模式通过 ctx.ui.custom 创建可搜索选择器，取消返回 undefined", async () => {
  const candidates = sessions(25);
  let customCalls = 0;

  const confirming = tuiContext((component) => {
    customCalls += 1;
    component.handleInput(KEY_DOWN);
    component.handleInput(KEY_ENTER);
  });
  const selected = await selectSourceSession(confirming.context, candidates);
  assert.equal(customCalls, 1);
  assert.equal(selected, candidates[1]!.path);

  const cancelling = tuiContext((component) => {
    component.handleInput(KEY_ESCAPE);
  });
  const cancelled = await selectSourceSession(cancelling.context, candidates);
  assert.equal(cancelled, undefined);
});

test("TUI 模式以标准面板覆盖层打开选择器，翻页键由覆盖层接收", async () => {
  const candidates = sessions(25);
  const harness = tuiContext((component) => {
    component.handleInput(KEY_PAGE_DOWN);
    component.handleInput(KEY_ENTER);
  });

  const selected = await selectSourceSession(harness.context, candidates);
  assert.equal(selected, candidates[10]!.path);
  // fullscreen 下主界面会先消费内嵌组件的 PgUp/PgDn，必须走覆盖层。
  assert.deepEqual(harness.customOptions(), {
    overlay: true,
    overlayOptions: { width: "80%", minWidth: 30, maxHeight: "80%", margin: 1 },
  });
  assert.deepEqual(SESSION_SELECTOR_OVERLAY_OPTIONS, {
    width: "80%",
    minWidth: 30,
    maxHeight: "80%",
    margin: 1,
  });
});

test("选择器实现 Focusable 并把 focused 传播给搜索输入", () => {
  const { component } = buildSelector(sessions(3));
  assert.equal(component.focused, false);
  assert.ok(!component.render(WIDTH).join("\n").includes(CURSOR_MARKER));

  component.focused = true;
  assert.equal(component.focused, true);
  assert.ok(component.render(WIDTH).join("\n").includes(CURSOR_MARKER));

  component.focused = false;
  assert.ok(!component.render(WIDTH).join("\n").includes(CURSOR_MARKER));
});

test("极窄宽度和 outputPad 不溢出，保留中文与原生焦点", () => {
  for (const outputPad of [0, 1]) {
    const { component } = buildSelector([sessionInfo(0, { name: "中文😀宽字符" })], undefined, { outputPad });
    component.focused = true;
    for (const width of [0, 1, 2, 3, 30, WIDTH]) {
      const lines = component.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `width=${width}, pad=${outputPad}`);
    }
    const lines = component.render(WIDTH);
    assert.ok(lines.join("\n").includes(CURSOR_MARKER));
    assert.ok(lines[1]!.startsWith(`${" ".repeat(outputPad)}选择`));
    assert.ok(lines.some((line) => line.startsWith(`${" ".repeat(outputPad)}> 1. 中文😀宽字符`)));
  }
});

test("隐藏的原生输入失焦，恢复时继承外部 focused", () => {
  let rows = DEFAULT_TERMINAL_ROWS;
  const { component } = buildSelector(sessions(3), undefined, { rows: () => rows });
  const input = component.children.find((child) => "focused" in child) as { focused: boolean };
  component.focused = true;
  assert.equal(input.focused, true);
  rows = 8;
  assert.ok(!component.render(WIDTH).join("\n").includes(CURSOR_MARKER));
  assert.equal(input.focused, false);
  component.focused = true;
  assert.equal(input.focused, false);
  rows = DEFAULT_TERMINAL_ROWS;
  assert.ok(component.render(WIDTH).join("\n").includes(CURSOR_MARKER));
  assert.equal(input.focused, true);
  rows = 8;
  component.render(WIDTH);
  component.focused = false;
  rows = DEFAULT_TERMINAL_ROWS;
  component.render(WIDTH);
  assert.equal(input.focused, false);
});

test("selectSourceSession 把 outputPad 传入真实选择器", async () => {
  for (const outputPad of [0, 1]) {
    const harness = tuiContext((component) => {
      assert.ok(component.render(WIDTH)[1]!.startsWith(`${" ".repeat(outputPad)}选择`));
      component.handleInput(KEY_ESCAPE);
    });
    assert.equal(await selectSourceSession(harness.context, sessions(1), outputPad), undefined);
  }
});

test("可见候选行数由覆盖层预算决定，10 只是上限", () => {
  // 标准覆盖层预算 = min(floor(rows*0.8), rows-2)，组件再扣除固定 chrome。
  assert.equal(overlayRowBudget(55), 44);
  assert.equal(overlayRowBudget(24), 19);
  assert.equal(overlayRowBudget(16), 12);
  assert.equal(overlayRowBudget(5), 3);
  assert.equal(overlayRowBudget(2), 0);
  assert.equal(overlayRowBudget(Number.NaN), 0);

  assert.equal(MIN_SELECTOR_ROWS, 12);
  assert.equal(sessionListCapacity(60), MAX_VISIBLE_SESSIONS);
  assert.equal(sessionListCapacity(24), MAX_VISIBLE_SESSIONS);
  assert.equal(sessionListCapacity(18), 6);
  assert.equal(sessionListCapacity(17), 5);
  assert.equal(sessionListCapacity(16), 4);
  assert.equal(sessionListCapacity(12), 1);
  assert.equal(sessionListCapacity(11), 0);
  assert.equal(sessionListCapacity(Number.NaN), 0);
});

test("终端缩放后窗口跟随覆盖层预算，翻页按实际行数且选中项始终可见", () => {
  let rows = DEFAULT_TERMINAL_ROWS;
  const candidates = sessions(25);
  const { component, selectedPath } = buildSelector(candidates, undefined, { rows: () => rows });
  // 渲染总行数不得超出覆盖层实际可用高度，否则底部提示会被裁掉。
  const assertWithinBudget = (lines: readonly string[]): void => {
    assert.ok(
      lines.length <= Math.max(1, overlayRowBudget(rows)),
      `rows=${rows} 时渲染 ${lines.length} 行超出覆盖层预算 ${overlayRowBudget(rows)}`,
    );
  };

  const initial = component.render(WIDTH);
  assert.equal(candidateLines(initial).length, MAX_VISIBLE_SESSIONS);
  assertWithinBudget(initial);

  // 16 行终端：覆盖层预算 12 行，扣除 chrome 后只剩 4 行候选。
  rows = 16;
  const shrunk = component.render(WIDTH);
  assert.equal(candidateLines(shrunk).length, 4);
  assertWithinBudget(shrunk);
  assert.match(shrunk.join("\n"), /1\. 会话 00/);

  // 翻页步长等于实际可见行数（4），而不是固定 10。
  component.handleInput(KEY_PAGE_DOWN);
  const paged = component.render(WIDTH);
  const pagedOutput = paged.join("\n");
  assert.equal(candidateLines(paged).length, 4);
  assert.match(pagedOutput, /位置 5\/25/);
  assert.match(pagedOutput, /> 5\. 会话 04/);
  assert.ok(!pagedOutput.includes("1. 会话 00"));

  // 再缩到只显示 1 行，选中项仍可见且业务选择不变。
  rows = 12;
  const minimal = component.render(WIDTH);
  assert.equal(candidateLines(minimal).length, 1);
  assert.match(minimal.join("\n"), /> 5\. 会话 04/);
  assertWithinBudget(minimal);

  rows = 55;
  const grown = component.render(WIDTH);
  assert.equal(candidateLines(grown).length, MAX_VISIBLE_SESSIONS);
  assert.match(grown.join("\n"), /> 5\. 会话 04/);
  assertWithinBudget(grown);

  component.handleInput(KEY_ENTER);
  assert.equal(selectedPath(), candidates[4]!.path);
});

test("终端过短时显示缩放提示、保留退出键，确认不触发选择", () => {
  const { selectedPath, isCancelled } = buildSelector(
    sessions(5),
    (component) => {
      const output = component.render(WIDTH).join("\n");
      assert.match(output, /终端高度不足/);
      assert.match(output, new RegExp(`至少 ${MIN_SELECTOR_ROWS} 行`));
      assert.match(output, /取消/);
      assert.ok(output.includes("Esc"));
      assert.equal(candidateLines(component.render(WIDTH)).length, 0);
      component.handleInput(KEY_ENTER);
      component.handleInput(KEY_ESCAPE);
    },
    { rows: () => 8 },
  );
  assert.equal(selectedPath(), undefined);
  assert.equal(isCancelled(), true);

  // 终端 11 行时覆盖层预算仅 8 行，仍属短屏：不显示任何候选。
  const budgetExhausted = buildSelector(
    sessions(5),
    (component) => {
      const lines = component.render(WIDTH);
      assert.equal(candidateLines(lines).length, 0);
      assert.ok(lines.length <= overlayRowBudget(11));
      assert.match(lines.join("\n"), /终端高度不足/);
    },
    { rows: () => 11 },
  );
  assert.equal(budgetExhausted.selectedPath(), undefined);
});

test("窄宽度下每行不超过渲染宽度并保留退出提示", () => {
  const narrowWidth = 28;
  const { component } = buildSelector(sessions(25));
  const lines = component.render(narrowWidth);
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= narrowWidth,
      `行宽 ${visibleWidth(line)} 超过 ${narrowWidth}：${JSON.stringify(line)}`,
    );
  }
  const output = lines.join("\n");
  assert.match(output, /取消/);
  assert.match(output, /位置 1\/25/);
});

test("自定义键位驱动导航与确认，底部提示反映实际绑定", () => {
  const custom = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.up": "k",
    "tui.select.down": "j",
    "tui.select.pageDown": "ctrl+f",
    "tui.select.confirm": "ctrl+s",
    "tui.select.cancel": "ctrl+q",
  });
  const candidates = sessions(25);
  const { component, selectedPath } = buildSelector(candidates, undefined, { keybindings: custom });

  const help = component.render(WIDTH).join("\n");
  assert.match(help, /K\/J 移动/);
  assert.match(help, /Ctrl\+F 翻页/);
  assert.match(help, /Ctrl\+S 选择/);
  assert.match(help, /Ctrl\+Q 取消/);

  component.handleInput("j");
  assert.match(component.render(WIDTH).join("\n"), /位置 2\/25/);
  component.handleInput("k");
  assert.match(component.render(WIDTH).join("\n"), /位置 1\/25/);

  component.handleInput("\x06"); // ctrl+f
  assert.match(component.render(WIDTH).join("\n"), /位置 11\/25/);

  component.handleInput("\x13"); // ctrl+s
  assert.equal(selectedPath(), candidates[10]!.path);
});

test("主题切换后 invalidate 重建颜色且不残留旧主题", () => {
  let accent = "\x1b[31m";
  let muted = "\x1b[90m";
  const theme: SessionSelectorTheme = {
    fg: (color, text) => `${color === "accent" ? accent : muted}${text}\x1b[0m`,
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
  };
  const { component } = buildSelector(sessions(3), undefined, { theme });
  assert.ok(component.render(WIDTH).join("\n").includes("\x1b[31m"));

  accent = "\x1b[34m";
  muted = "\x1b[37m";
  component.invalidate();
  const after = component.render(WIDTH).join("\n");
  assert.ok(!after.includes("\x1b[31m"), "旧 accent 颜色残留");
  assert.ok(!after.includes("\x1b[90m"), "旧 muted 颜色残留");
  assert.ok(after.includes("\x1b[34m"));
  assert.ok(after.includes("\x1b[37m"));
});

test("搜索输入支持中文、emoji、多字符粘贴与退格", () => {
  const emoji = sessionInfo(0, { name: "中文😀目标", firstMessage: "中文😀目标" });
  const chinese = sessionInfo(1, { name: "中文其他", firstMessage: "中文其他" });
  const other = sessionInfo(2);
  const { component, selectedPath } = buildSelector([emoji, chinese, other]);

  component.handleInput("\x1b[200~中文😀\x1b[201~");
  const pasted = component.render(WIDTH).join("\n");
  assert.match(pasted, /筛选 1\/3/);
  assert.ok(pasted.includes("中文😀目标"));

  component.handleInput("\x7f");
  const backspaced = component.render(WIDTH).join("\n");
  assert.match(backspaced, /筛选 2\/3/);
  assert.match(backspaced, /位置 1\/2/);

  component.handleInput(KEY_ENTER);
  assert.equal(selectedPath(), emoji.path);
});

test("终端仅 1..6 行时只渲染可容纳的提示，保留取消且确认不选不可见会话", () => {
  const candidates = sessions(5);
  for (let rows = 1; rows <= 6; rows += 1) {
    const { selectedPath } = buildSelector(candidates, (instance) => {
      const lines = instance.render(WIDTH);
      assert.ok(lines.length <= rows, `rows=${rows} 时渲染 ${lines.length} 行超出`);
      assert.ok(
        lines.length <= Math.max(1, overlayRowBudget(rows)),
        `rows=${rows} 时渲染 ${lines.length} 行超出覆盖层预算`,
      );
      assert.ok(visibleWidth(lines[0] ?? "") <= WIDTH);
      const output = lines.join("\n");
      assert.match(output, /取消/);
      assert.ok(output.includes("Esc"));
      instance.handleInput(KEY_ENTER);
      instance.handleInput(KEY_DOWN);
      instance.handleInput(KEY_PAGE_DOWN);
    }, { rows: () => rows });
    assert.equal(selectedPath(), undefined, `rows=${rows} 时不应选择不可见会话`);
  }
});
