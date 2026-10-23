import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionCommandContext, SessionInfo } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";

import {
  filterSessionCandidates,
  formatSessionLabel,
  MAX_VISIBLE_SESSIONS,
  SearchableSessionSelector,
  selectSourceSession,
  type SessionSelectorKeybindings,
  type SessionSelectorTheme,
} from "../src/extension/review-ui.ts";

const BASE_TIME = Date.parse("2026-09-07T00:00:00.000Z");
const WIDTH = 120;

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

function buildSelector(
  candidates: readonly SessionInfo[],
  drive?: (component: SearchableSessionSelector) => void,
) {
  let selected: string | undefined;
  let cancelled = false;
  const component = new SearchableSessionSelector({
    sessions: candidates,
    theme: THEME,
    keybindings: KEYBINDINGS,
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
}

function tuiContext(drive: (component: SearchableSessionSelector) => void): ExtensionCommandContext {
  return {
    mode: "tui",
    ui: {
      select: async () => {
        throw new Error("TUI 模式不应回退到 ctx.ui.select");
      },
      custom: async (factory: unknown) => new Promise<unknown>((resolve) => {
        const create = factory as (
          tui: { requestRender: () => void },
          theme: SessionSelectorTheme,
          keybindings: SessionSelectorKeybindings,
          done: (value: string | null) => void,
        ) => SearchableSessionSelector;
        const component = create({ requestRender: () => {} }, THEME, KEYBINDINGS, resolve as (value: string | null) => void);
        drive(component);
      }),
    },
  } as unknown as ExtensionCommandContext;
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
  const selected = await selectSourceSession(confirming, candidates);
  assert.equal(customCalls, 1);
  assert.equal(selected, candidates[1]!.path);

  const cancelling = tuiContext((component) => {
    component.handleInput(KEY_ESCAPE);
  });
  const cancelled = await selectSourceSession(cancelling, candidates);
  assert.equal(cancelled, undefined);
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
