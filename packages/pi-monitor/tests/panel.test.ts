import assert from "node:assert/strict";
import { type TestContext, it } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { MonitorPanel } from "../src/panel.ts";
import { panelAvailableRows } from "../src/panel-view.ts";
import type { MonitorRuntime } from "../src/runtime.ts";
import type { MonitorRecord } from "../src/types.ts";

const DEFAULT_BINDINGS: Record<string, string[]> = {
  "tui.select.up": ["up"],
  "tui.select.down": ["down"],
  "tui.select.pageUp": ["pageUp"],
  "tui.select.pageDown": ["pageDown"],
  "tui.select.confirm": ["enter"],
  "tui.select.cancel": ["escape"],
};

function bindings(overrides: Record<string, string[]> = {}): KeybindingsManager {
  const table = { ...DEFAULT_BINDINGS, ...overrides };
  return {
    matches: (data: string, binding: string) => (table[binding] ?? []).includes(data),
    getKeys: (binding: string) => table[binding] ?? [],
  } as unknown as KeybindingsManager;
}

function plainTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
}

interface MarkerTheme extends Theme {
  marker: string;
}

function markerTheme(): MarkerTheme {
  const theme = {
    marker: "A",
    fg(color: string, text: string) {
      return `{${theme.marker}:${color}}${text}{/}`;
    },
    bg(color: string, text: string) {
      return `{${theme.marker}:${color}}${text}{/}`;
    },
    bold(text: string) {
      return text;
    },
  };
  return theme as unknown as MarkerTheme;
}

function record(overrides: Partial<MonitorRecord> = {}): MonitorRecord {
  return {
    id: "task-1", ownerSessionId: "owner-1", name: "任务 A", purpose: "等待测试事件",
    explanation: "只解释", mode: "continuous", delivery: "explain", command: "node", args: [],
    cwd: "/tmp", intervalMs: 60_000, timeoutMs: 5_000, createdAt: 0, logLevel: "info",
    status: "running", nextCheckAt: 0, failures: 0, seenIds: [], pending: [],
    ...overrides,
  };
}

class FakeRuntime {
  list: MonitorRecord[] = [];
  calls: Array<{ action: string; id: string }> = [];
  relaunches: string[] = [];
  failReads?: string;
  hold = false;
  panelOpen = false;
  private pending: Array<() => void> = [];

  setPanelOpen(open: boolean): void {
    this.panelOpen = open;
  }

  records(): MonitorRecord[] {
    if (this.failReads) throw new Error(this.failReads);
    return this.list;
  }

  act(action: string, input: { id: string }): Promise<unknown> {
    this.calls.push({ action, id: input.id });
    if (!this.hold) return Promise.resolve({});
    return new Promise((resolve) => {
      this.pending.push(() => resolve({}));
    });
  }

  relaunch(_ctx: unknown, id: string): MonitorRecord {
    this.relaunches.push(id);
    return record({ id: "task-new", name: "重启后的任务" });
  }

  release(): void {
    for (const run of this.pending.splice(0)) run();
  }
}

function createPanel(
  t: TestContext,
  runtime: FakeRuntime,
  options: {
    rows?: number; theme?: Theme; keybindings?: KeybindingsManager;
    initialId?: string; showAll?: boolean; outputPad?: number;
  } = {},
) {
  let renders = 0;
  let doneCount = 0;
  const tui = {
    requestRender: () => { renders += 1; },
    terminal: { rows: options.rows ?? 24 },
  } as unknown as TUI;
  const panel = new MonitorPanel({
    runtime: runtime as unknown as MonitorRuntime,
    ctx: {} as ExtensionCommandContext,
    tui,
    theme: options.theme ?? plainTheme(),
    keybindings: options.keybindings ?? bindings(),
    done: () => { doneCount += 1; },
    initialId: options.initialId,
    showAll: options.showAll,
    outputPad: options.outputPad ?? 1,
  });
  t.after(() => panel.dispose());
  return { panel, renders: () => renders, doneCount: () => doneCount };
}

function assertWithinWidth(rows: string[], width: number): void {
  for (const row of rows) {
    assert.ok(visibleWidth(row) <= width, `行宽 ${visibleWidth(row)} 超过 ${width}：${JSON.stringify(row)}`);
  }
}

function selectedRow(rows: string[]): string {
  return rows.find((row) => row.includes("❯")) ?? "";
}

function manyRecords(count: number): MonitorRecord[] {
  return Array.from({ length: count }, (_, index) =>
    record({ id: `task-${index + 1}`, name: `任务 ${String(index + 1).padStart(2, "0")}` }));
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// 详情正文使用 Pi 原生 Markdown 组件，需要先初始化全局 Markdown 主题。
initTheme("dark", false);

it("超过一屏后选中项仍可见，窗口随选择移动", (t) => {
  const runtime = new FakeRuntime();
  runtime.list = manyRecords(16);
  const { panel } = createPanel(t, runtime, { rows: 20 });

  assert.match(selectedRow(panel.render(80)), /任务 01/);
  for (let index = 0; index < 14; index += 1) panel.handleInput("down");
  const rows = panel.render(80);
  assert.match(selectedRow(rows), /任务 15/);
  assert.ok(!rows.some((row) => row.includes("任务 01")), "列表首项应已滚出窗口");
  assert.ok(rows.some((row) => row.includes("任务 16")) === false, "窗口只显示实际可见行");

  panel.handleInput("down");
  const last = panel.render(80);
  assert.match(selectedRow(last), /任务 16/);
  assert.ok(last.some((row) => row.includes("/16 ·")), `底部应显示窗口范围：${last.at(-1)}`);
});

it("空列表显示提示且业务按键无效", (t) => {
  const runtime = new FakeRuntime();
  const { panel } = createPanel(t, runtime, { rows: 24 });
  const rows = panel.render(80);
  assert.ok(rows.join("\n").includes("当前分支没有监听任务"));
  panel.handleInput("s");
  panel.handleInput("r");
  assert.deepEqual(runtime.calls, []);
  assert.deepEqual(runtime.relaunches, []);
});

it("列表重排后按稳定 id 继续操作", (t) => {
  const runtime = new FakeRuntime();
  runtime.list = [record({ id: "a", name: "A" }), record({ id: "b", name: "B" }), record({ id: "c", name: "C" })];
  const { panel } = createPanel(t, runtime, { rows: 24 });

  panel.handleInput("down");
  runtime.list = [record({ id: "c", name: "C" }), record({ id: "b", name: "B" }), record({ id: "a", name: "A" })];
  panel.render(80);
  assert.match(selectedRow(panel.render(80)), /B/);

  panel.handleInput("s");
  assert.deepEqual(runtime.calls, []);
  panel.handleInput("s");
  assert.deepEqual(runtime.calls, [{ action: "stop", id: "b" }]);
});

it("切换目标后旧确认失效，不会误操作上一项", (t) => {
  const runtime = new FakeRuntime();
  runtime.list = [record({ id: "a", name: "A" }), record({ id: "b", name: "B" })];
  const { panel } = createPanel(t, runtime, { rows: 24 });

  panel.handleInput("s");
  panel.handleInput("down");
  panel.handleInput("s");
  assert.deepEqual(runtime.calls, [], "切换目标后第一次 s 只应进入新确认");
  assert.ok(panel.render(80).join("\n").includes("再按 s 停止 B"));
  panel.handleInput("s");
  assert.deepEqual(runtime.calls, [{ action: "stop", id: "b" }]);
});

it("选中目标消失后可见回退并取消旧确认", (t) => {
  const runtime = new FakeRuntime();
  runtime.list = [record({ id: "a", name: "A" }), record({ id: "b", name: "B" }), record({ id: "c", name: "C" })];
  const { panel } = createPanel(t, runtime, { rows: 24 });

  panel.handleInput("down");
  panel.handleInput("s");
  runtime.list = [record({ id: "a", name: "A" }), record({ id: "c", name: "C" })];
  panel.handleInput("down");

  const rows = panel.render(80);
  assert.ok(rows.join("\n").includes("停止确认目标已不在列表"));
  assert.match(selectedRow(rows), /C/);
  panel.handleInput("s");
  assert.deepEqual(runtime.calls, []);
  panel.handleInput("s");
  assert.deepEqual(runtime.calls, [{ action: "stop", id: "c" }]);
});

it("busy 期间拒绝重复触发，关闭后忽略迟到结果", async (t) => {
  const runtime = new FakeRuntime();
  runtime.list = [record({ id: "task-1", name: "构建" })];
  runtime.hold = true;
  const { panel, renders } = createPanel(t, runtime, { rows: 24 });

  panel.handleInput("s");
  panel.handleInput("s");
  assert.deepEqual(runtime.calls, [{ action: "stop", id: "task-1" }]);
  panel.handleInput("s");
  panel.handleInput("s");
  assert.equal(runtime.calls.length, 1, "busy 时不得再次执行停止");
  assert.ok(panel.render(80).join("\n").includes("上一个操作尚未完成"));

  const before = renders();
  panel.dispose();
  runtime.release();
  await flush();
  assert.equal(renders(), before, "dispose 后迟到结果不得重绘");
  assert.ok(!panel.render(80).join("\n").includes("已停止 构建"));
});

it("关闭幂等，关闭后按键不再重绘", (t) => {
  const runtime = new FakeRuntime();
  runtime.list = [record({ id: "a", name: "A" })];
  const { panel, renders, doneCount } = createPanel(t, runtime, { rows: 24 });

  panel.handleInput("escape");
  const afterClose = renders();
  panel.handleInput("escape");
  panel.handleInput("down");
  assert.equal(doneCount(), 1);
  assert.equal(renders(), afterClose);
});

it("短屏显示缩放提示并保留退出能力", (t) => {
  const runtime = new FakeRuntime();
  runtime.list = manyRecords(5);
  const { panel } = createPanel(t, runtime, {
    rows: 8,
    keybindings: bindings({ "tui.select.cancel": ["q"] }),
  });

  const rows = panel.render(40);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].includes("监听任务"));
  assert.ok(rows[1].includes("窗口过小"));
  assert.ok(rows[1].includes("Q 关闭"));
  assertWithinWidth(rows, 40);
  panel.handleInput("q");
  assert.equal(rows.length, 2);
});

it("resize 与窄屏下每行不超过传入宽度", (t) => {
  const runtime = new FakeRuntime();
  runtime.list = manyRecords(6).map((task, index) => record({
    ...task,
    name: index === 0 ? "🚀 发布检查 · 很长的任务名称用于验证中英文混排行宽" : task.name,
    pending: index === 1 ? [{ id: "batch-1", taskId: task.id, checkedAt: 0, events: [{ id: "e1", summary: "事件" }] }] : [],
  }));
  const { panel } = createPanel(t, runtime, { rows: 24 });

  for (const width of [20, 24, 40, 80, 120]) {
    const rows = panel.render(width);
    assertWithinWidth(rows, width);
    if (width === 20) assert.ok(rows.some((row) => row.includes("🚀")), "窄屏仍保留任务名");
  }
  panel.handleInput("enter");
  assertWithinWidth(panel.render(30), 30);
});

it("outputPad 左右留白且不溢出", (t) => {
  const runtime = new FakeRuntime();
  runtime.list = [record({ id: "a", name: "A" })];
  const padded = createPanel(t, runtime, { rows: 24, outputPad: 1 });
  for (const row of padded.panel.render(80)) {
    assert.ok(row.startsWith(" ") && row.endsWith(" "), `outputPad=1 应有左右留白：${JSON.stringify(row)}`);
    assert.ok(visibleWidth(row) <= 80);
  }
  const plain = createPanel(t, runtime, { rows: 24, outputPad: 0 });
  for (const row of plain.panel.render(80)) {
    assert.ok(!row.startsWith(" ") || visibleWidth(row) <= 80);
    assert.ok(visibleWidth(row) <= 80);
  }
});

it("注入自定义键位并让提示与实际绑定一致", (t) => {
  const runtime = new FakeRuntime();
  runtime.list = [record({ id: "a", name: "A" }), record({ id: "b", name: "B" })];
  const { panel } = createPanel(t, runtime, {
    rows: 24,
    keybindings: bindings({
      "tui.select.up": ["k"], "tui.select.down": ["j"], "tui.select.confirm": ["space"],
      "tui.select.cancel": ["q"], "tui.select.pageUp": ["u"], "tui.select.pageDown": ["d"],
    }),
  });

  const hints = panel.render(80).at(-1) ?? "";
  assert.ok(hints.includes("K/J"), hints);
  assert.ok(hints.includes("Space"), hints);
  assert.ok(hints.includes("Q"), hints);

  panel.handleInput("up");
  assert.match(selectedRow(panel.render(80)), /A/, "默认方向键不应再移动选择");
  panel.handleInput("j");
  assert.match(selectedRow(panel.render(80)), /B/);
  panel.handleInput("space");
  assert.ok(panel.render(80).join("\n").includes("监听详情"));
});

it("详情翻页受实际行数限制并可回到顶部", (t) => {
  const runtime = new FakeRuntime();
  const events = Array.from({ length: 4 }, (_, index) => ({
    id: `e${index}`, summary: `事件 ${index}`, data: { message: `数据 ${index}`, list: [1, 2, 3] },
  }));
  runtime.list = [record({
    id: "task-1", name: "详情任务",
    pending: [{ id: "batch-1", taskId: "task-1", checkedAt: 0, events }],
  })];
  const { panel } = createPanel(t, runtime, { rows: 18 });

  panel.handleInput("enter");
  const first = panel.render(80);
  assert.ok(first.join("\n").includes("监听详情"));
  assertWithinWidth(first, 80);

  for (let index = 0; index < 60; index += 1) panel.handleInput("pageDown");
  const bottom = panel.render(80);
  const bottomHint = bottom.at(-1) ?? "";
  const range = /(\d+)-(\d+)\/(\d+)/.exec(bottomHint);
  assert.ok(range, `应显示滚动范围：${bottomHint}`);
  assert.equal(range[2], range[3], "翻页到底后不得超出内容");

  for (let index = 0; index < 60; index += 1) panel.handleInput("up");
  const top = panel.render(80);
  const topRange = /(\d+)-(\d+)\/(\d+)/.exec(top.at(-1) ?? "");
  assert.ok(topRange);
  assert.equal(topRange[1], "1", "上翻到底应回到第一行");
  assertWithinWidth(top, 80);
});

it("主题变化后 invalidate 不残留旧颜色", (t) => {
  const runtime = new FakeRuntime();
  runtime.list = [record({ id: "a", name: "A", pending: [{ id: "batch-1", taskId: "a", checkedAt: 0, events: [{ id: "e1", summary: "事件" }] }] })];
  const theme = markerTheme();
  const { panel } = createPanel(t, runtime, { rows: 24, theme });

  const before = panel.render(80).join("\n");
  assert.ok(before.includes("{A:"));

  panel.handleInput("enter");
  assert.ok(panel.render(80).join("\n").includes("{A:"));
  theme.marker = "B";
  panel.invalidate();
  const after = panel.render(80).join("\n");
  assert.ok(after.includes("{B:"), "invalidate 后应使用新主题");
  assert.ok(!after.includes("{A:"), "invalidate 后不得残留旧主题颜色");
});

it("读取运行时失败时展示错误且不影响按键", (t) => {
  const runtime = new FakeRuntime();
  runtime.failReads = "读取监听失败";
  const { panel } = createPanel(t, runtime, { rows: 24 });

  const rows = panel.render(80);
  assert.ok(rows.join("\n").includes("读取监听失败"));
  panel.handleInput("down");
  panel.handleInput("s");
  assert.deepEqual(runtime.calls, []);
});

it("a 切换全部任务并保留已结束分隔", (t) => {
  const runtime = new FakeRuntime();
  runtime.list = [
    record({ id: "a", name: "运行中" }),
    record({ id: "b", name: "已完成", status: "completed" }),
  ];
  const { panel } = createPanel(t, runtime, { rows: 24 });

  assert.ok(!panel.render(80).join("\n").includes("已完成"));
  panel.handleInput("a");
  const rows = panel.render(80);
  assert.ok(rows.join("\n").includes("已结束 1"));
  assert.ok(rows.join("\n").includes("已完成"));
  assert.match(selectedRow(rows), /运行中/);
});

it("初始 id 前缀唯一时直接进入详情，不存在时报错", (t) => {
  const runtime = new FakeRuntime();
  runtime.list = [record({ id: "abcd1234", name: "目标" }), record({ id: "abcd9999", name: "另一个" })];

  const unique = createPanel(t, runtime, { rows: 24, initialId: "abcd12" });
  assert.ok(unique.panel.render(80).join("\n").includes("监听详情"));

  const ambiguous = createPanel(t, runtime, { rows: 24, initialId: "abcd" });
  assert.ok(ambiguous.panel.render(80).join("\n").includes("id 前缀不唯一"));

  const missing = createPanel(t, runtime, { rows: 24, initialId: "zzzz" });
  assert.ok(missing.panel.render(80).join("\n").includes("找不到监听任务"));
});

it("dispose 后输入不再触发任何业务操作", (t) => {
  const runtime = new FakeRuntime();
  runtime.list = [record({ id: "a", name: "A" }), record({ id: "b", name: "B", status: "stopped" })];
  runtime.hold = true;
  const { panel, renders } = createPanel(t, runtime, { rows: 24, showAll: true });
  const before = renders();
  panel.dispose();
  panel.handleInput("s");
  panel.handleInput("s");
  panel.handleInput("r");
  assert.deepEqual(runtime.calls, []);
  assert.deepEqual(runtime.relaunches, []);
  assert.equal(renders(), before, "dispose 后不得重绘");
});

it("关闭后输入不再触发任何业务操作", (t) => {
  const runtime = new FakeRuntime();
  runtime.list = [record({ id: "a", name: "A" }), record({ id: "b", name: "B", status: "completed" })];
  const { panel, doneCount } = createPanel(t, runtime, { rows: 24, showAll: true });
  panel.handleInput("escape");
  panel.handleInput("s");
  panel.handleInput("s");
  panel.handleInput("r");
  assert.equal(doneCount(), 1);
  assert.deepEqual(runtime.calls, []);
  assert.deepEqual(runtime.relaunches, []);
});

it("短屏与极窄屏只允许退出，不操作不可见目标", (t) => {
  const runtime = new FakeRuntime();
  runtime.list = [record({ id: "done", name: "已结束", status: "stopped" })];
  const short = createPanel(t, runtime, { rows: 6, showAll: true });
  const shortRows = short.panel.render(80);
  assert.ok(shortRows.join("\n").includes("窗口过小"));
  short.panel.handleInput("s");
  short.panel.handleInput("s");
  short.panel.handleInput("r");
  assert.deepEqual(runtime.calls, []);
  assert.deepEqual(runtime.relaunches, []);
  short.panel.handleInput("escape");
  assert.equal(short.doneCount(), 1);

  const narrow = createPanel(t, runtime, { rows: 24, showAll: true });
  for (const row of narrow.panel.render(1)) assertWithinWidth([row], 1);
  narrow.panel.handleInput("s");
  narrow.panel.handleInput("s");
  narrow.panel.handleInput("r");
  assert.deepEqual(runtime.calls, []);
  assert.deepEqual(runtime.relaunches, []);
  narrow.panel.handleInput("escape");
  assert.equal(narrow.doneCount(), 1);
});

it("busy 跨分支时 stop/resume/relaunch 都不得重复执行", async (t) => {
  const runtime = new FakeRuntime();
  runtime.list = [
    record({ id: "run", name: "运行" }),
    record({ id: "pause", name: "暂停", status: "paused" }),
    record({ id: "done", name: "完成", status: "completed" }),
  ];
  runtime.hold = true;
  const { panel } = createPanel(t, runtime, { rows: 24 });

  panel.handleInput("s");
  panel.handleInput("s");
  assert.deepEqual(runtime.calls, [{ action: "stop", id: "run" }]);
  panel.handleInput("a");
  panel.handleInput("down");
  panel.handleInput("r");
  panel.handleInput("down");
  panel.handleInput("r");
  assert.deepEqual(runtime.calls, [{ action: "stop", id: "run" }], "busy 时 resume 不得执行");
  assert.deepEqual(runtime.relaunches, [], "busy 时 relaunch 不得执行");
  runtime.release();
  await flush();
});

it("任意宽度与 padding 不溢出，短屏行数不超过预算", (t) => {
  const runtime = new FakeRuntime();
  runtime.list = manyRecords(5);
  const budget = panelAvailableRows(24);
  for (const outputPad of [0, 1] as const) {
    const { panel } = createPanel(t, runtime, { rows: 24, outputPad });
    for (const width of [0, 1, 2, 3, 30]) {
      const rows = panel.render(width);
      assertWithinWidth(rows, width);
      assert.ok(rows.length <= budget, `width ${width} pad ${outputPad} 渲染 ${rows.length} 行超过预算 ${budget}`);
    }
  }
  for (const terminalRows of [1, 2, 3, 4, 5, 6, 8, 12]) {
    const { panel } = createPanel(t, runtime, { rows: terminalRows });
    const rows = panel.render(40);
    const limit = panelAvailableRows(terminalRows);
    assert.ok(rows.length <= limit, `rows ${terminalRows} 渲染 ${rows.length} 行超过预算 ${limit}`);
    if (limit >= 1) assert.ok(rows.join("\n").includes("关闭"), `rows ${terminalRows} 丢失退出提示`);
  }
});

it("绘制顺序与业务操作顺序一致，消失后给出可见回退", (t) => {
  const runtime = new FakeRuntime();
  runtime.list = [
    record({ id: "done", name: "完成", status: "completed" }),
    record({ id: "a", name: "A" }),
    record({ id: "b", name: "B" }),
  ];
  const { panel } = createPanel(t, runtime, { rows: 24, showAll: true });
  const firstRows = panel.render(80);
  assert.match(selectedRow(firstRows), /A/);
  const bIndex = firstRows.findIndex((row) => row.includes("B"));
  const doneIndex = firstRows.findIndex((row) => row.includes("完成"));
  assert.ok(bIndex >= 0 && doneIndex > bIndex, "活跃任务应排在已结束任务之前");

  panel.handleInput("down");
  panel.handleInput("down");
  assert.match(selectedRow(panel.render(80)), /完成/);
  panel.handleInput("s");
  panel.handleInput("s");
  assert.deepEqual(runtime.calls, [{ action: "stop", id: "done" }], "业务操作应命中绘制中选中的已完成任务");

  const fallback = new FakeRuntime();
  fallback.list = [record({ id: "a", name: "A" }), record({ id: "b", name: "B" })];
  const second = createPanel(t, fallback, { rows: 24 });
  second.panel.handleInput("down");
  fallback.list = [record({ id: "a", name: "A" })];
  second.panel.handleInput("down");
  const rows = second.panel.render(80);
  assert.ok(rows.join("\n").includes("所选任务已不在列表"), "消失后应有可见回退提示");
  assert.match(selectedRow(rows), /A/);
  second.panel.handleInput("s");
  second.panel.handleInput("s");
  assert.deepEqual(fallback.calls, [{ action: "stop", id: "a" }], "回退选择必须绑定新目标 id");
});

it("同步切换目标后本次业务键不作用到新对象", (t) => {
  const runtime = new FakeRuntime();
  runtime.list = [
    record({ id: "a", name: "A", status: "paused" }),
    record({ id: "b", name: "B", status: "paused" }),
  ];
  const { panel, renders } = createPanel(t, runtime, { rows: 24 });
  panel.render(80);
  panel.handleInput("down");
  assert.match(selectedRow(panel.render(80)), /B/);

  runtime.list = [record({ id: "a", name: "A", status: "paused" })];
  const before = renders();
  panel.handleInput("r");
  assert.ok(renders() > before, "目标变化后应先重绘可见目标");
  assert.deepEqual(runtime.calls, [], "A 未收到明确按键，不得被恢复");
  assert.deepEqual(runtime.relaunches, []);
  assert.match(selectedRow(panel.render(80)), /A/);

  panel.handleInput("r");
  assert.deepEqual(runtime.calls, [{ action: "resume", id: "a" }], "下一次明确按键才作用于可见任务");

  const stoppedRuntime = new FakeRuntime();
  stoppedRuntime.list = [
    record({ id: "done", name: "完成", status: "completed" }),
    record({ id: "b", name: "B", status: "paused" }),
  ];
  const stopped = createPanel(t, stoppedRuntime, { rows: 24, showAll: true });
  stopped.panel.render(80);
  stoppedRuntime.list = [record({ id: "done", name: "完成", status: "completed" })];
  stopped.panel.handleInput("r");
  assert.deepEqual(stoppedRuntime.relaunches, [], "首次 r 不得重新启动回退目标");
  stopped.panel.handleInput("r");
  assert.deepEqual(stoppedRuntime.relaunches, ["done"], "下一次 r 才重新启动可见目标");
});

it("详情目标消失后本次业务键不作用到回退目标", (t) => {
  const runtime = new FakeRuntime();
  runtime.list = [
    record({ id: "a", name: "A", status: "paused" }),
    record({ id: "b", name: "B", status: "paused" }),
  ];
  const { panel } = createPanel(t, runtime, { rows: 24 });
  panel.render(80);
  panel.handleInput("down");
  panel.handleInput("enter");
  assert.ok(panel.render(80).join("\n").includes("监听详情"));

  runtime.list = [record({ id: "a", name: "A", status: "paused" })];
  panel.handleInput("s");
  assert.deepEqual(runtime.calls, [], "详情消失后的首个 s 不得停止回退目标");
  const rows = panel.render(80);
  assert.ok(!rows.join("\n").includes("监听详情"), "详情消失后应回到列表");
  assert.match(selectedRow(rows), /A/);
  panel.handleInput("s");
  panel.handleInput("s");
  assert.deepEqual(runtime.calls, [{ action: "stop", id: "a" }]);
});

it("定时刷新显示回退后业务键按可见目标执行", async (t) => {
  const runtime = new FakeRuntime();
  runtime.list = [
    record({ id: "a", name: "A", status: "paused" }),
    record({ id: "b", name: "B", status: "paused" }),
  ];
  const { panel, renders } = createPanel(t, runtime, { rows: 24 });
  panel.render(80);
  panel.handleInput("down");
  runtime.list = [record({ id: "a", name: "A", status: "paused" })];

  const before = renders();
  const deadline = Date.now() + 3_000;
  while (renders() === before && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(renders() > before, "定时同步应主动重绘回退后的选择");
  panel.handleInput("r");
  assert.deepEqual(runtime.calls, [{ action: "resume", id: "a" }], "已呈现 A 时 r 应直接作用于 A");
});

it("短屏窄面板把退出提示放在最前", (t) => {
  const runtime = new FakeRuntime();
  runtime.list = manyRecords(5);
  const { panel } = createPanel(t, runtime, {
    rows: 8,
    outputPad: 1,
    keybindings: bindings({ "tui.select.cancel": ["q"] }),
  });

  const rows = panel.render(30);
  assertWithinWidth(rows, 30);
  const notice = (rows.at(-1) ?? "").trim();
  assert.ok(notice.startsWith("Q 关闭"), `退出提示应在最前：${notice}`);
  assert.ok(notice.includes("窗口过小"), `缩放说明应保留：${notice}`);

  for (const terminalRows of [1, 2, 3, 4, 5, 6, 8, 12]) {
    const sized = createPanel(t, runtime, { rows: terminalRows, outputPad: 1 });
    const sizedRows = sized.panel.render(30);
    assertWithinWidth(sizedRows, 30);
    if (panelAvailableRows(terminalRows) >= 1) {
      assert.ok(sizedRows.join("\n").includes("关闭"), `rows ${terminalRows} 丢失退出提示`);
    }
  }
});

/** Markdown 主题输出 ANSI 颜色，断言正文前先去掉颜色序列。 */
function stripColors(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 0x1b) {
      out += text[index];
      continue;
    }
    index += 1;
    while (index < text.length && text[index] !== "m") index += 1;
  }
  return out;
}

it("详情正文按面板内宽换行，滚动各页可读到行尾", (t) => {
  const tail = "结尾标记END";
  const purpose = `${"很长的中文说明行".repeat(12)}${tail}`;
  for (const outputPad of [0, 1] as const) {
    const runtime = new FakeRuntime();
    runtime.list = [record({ id: "task-1", name: "长文任务", purpose })];
    const { panel } = createPanel(t, runtime, { rows: 12, outputPad });
    panel.handleInput("enter");

    const pages: string[] = [];
    let previous = "";
    for (let index = 0; index < 40; index += 1) {
      const rows = panel.render(30);
      assertWithinWidth(rows, 30);
      // 去掉标题、分隔线和提示行，只保留正文行；不混入 chrome 才能比较跨页正文。
      const body = rows.slice(1, -1)
        .filter((row) => !/^─+$/u.test(row.trim()))
        .map((row) => row.trim())
        .join("\n");
      const page = stripColors(body);
      if (page === previous) break;
      pages.push(page);
      previous = page;
      panel.handleInput("pageDown");
    }

    const squashed = pages.join("").replace(/\s+/gu, "");
    assert.ok(squashed.includes(purpose), `pad ${outputPad} 的详情正文在滚动页中丢失字符`);
  }
});
