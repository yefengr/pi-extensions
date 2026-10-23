import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";

import type { ExtensionAPI, SessionEntry, SessionInfo } from "@earendil-works/pi-coding-agent";

import {
  buildSessionProjection,
  loadSourceSnapshot,
  type ReviewOverhead,
  type SourceSnapshot,
  TaskRangeError,
  validateTaskRange,
} from "../core/index.ts";
import { TaskEfficiencyError } from "../extension/errors.ts";
import {
  buildSourceReference,
  compactReportMarker,
  confirmationForProposal,
  createProposal,
  projectionDigest,
  proposalId,
  revisionForProposal,
  SOURCE_ENTRY_TYPE,
  type ProposalInput,
} from "../extension/records.ts";
import {
  registerTaskEfficiencyExtension,
  REVIEW_NAME_PREFIX,
  type TaskEfficiencyExtensionDependencies,
} from "../extension/runtime.ts";
import { parseScopeAction, scopeActionOptions } from "../extension/review-ui.ts";
import { assistant, entry, header, user, writeSession } from "./fixtures.ts";

test("范围动作只接受当前中文标签，旧英文动作按取消处理", () => {
  const actions = ["confirm", "revise", "reselect", "cancel"];
  assert.deepEqual(scopeActionOptions().map(parseScopeAction), actions);
  for (const value of ["Confirm", "Revise", "Reselect", "Cancel", undefined, "unknown"]) {
    assert.equal(parseScopeAction(value), "cancel");
  }
});

const NOW = new Date("2026-09-07T01:00:00.000Z");

type RegisteredTool = {
  readonly parameters: {
    readonly additionalProperties?: boolean;
    readonly properties?: {
      readonly confidence?: { readonly type?: string; readonly enum?: readonly string[] };
      readonly beforeCursor?: { readonly type?: string; readonly minimum?: number };
    };
  };
  execute: (id: string, parameters: any, signal: undefined, update: undefined, ctx: any) => Promise<any>;
};

function custom(customType: string, data: unknown, index = 0): SessionEntry {
  return {
    type: "custom",
    id: `custom-${index}`,
    parentId: null,
    timestamp: NOW.toISOString(),
    customType,
    data,
  } as unknown as SessionEntry;
}

function runtime(
  entries: SessionEntry[],
  dependencies: TaskEfficiencyExtensionDependencies = {},
  appendEntry: (customType: string, data: unknown) => void = (customType, data) => {
    entries.push(custom(customType, data, entries.length));
  },
  useProductionReader = false,
) {
  const commands = new Map<string, any>();
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    registerTool(tool: RegisteredTool & { name: string }) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.set(event, handler);
    },
    appendEntry,
  } as unknown as ExtensionAPI;
  registerTaskEfficiencyExtension(pi, useProductionReader
    ? dependencies
    : { readReviewEntries: async (ctx) => ctx.sessionManager.getBranch(), ...dependencies });
  return { commands, tools, handlers, pi };
}

function toolContext(entries: SessionEntry[], choices: Array<string | undefined> = [], inputs: Array<string | undefined> = []) {
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  return {
    hasUI: true,
    ui: {
      select: async (_title: string, _options: string[]) => choices.shift(),
      input: async () => inputs.shift(),
      notify: (message: string, type?: string) => notifications.push({ message, type }),
    },
    sessionManager: { getBranch: () => entries },
    notifications,
  };
}

async function reviewFixture(t: TestContext) {
  const sourcePath = await writeSession(t, [
    header(),
    user("u1", null, 0, "implement the feature"),
    assistant("a1", "u1", 2),
  ]);
  const snapshot = await loadSourceSnapshot(sourcePath);
  const range = validateTaskRange(snapshot, { startEntryId: "u1", endEntryId: "a1" });
  const marker = buildSourceReference(snapshot, projectionDigest(buildSessionProjection(snapshot)));
  const entries = [custom(SOURCE_ENTRY_TYPE, marker)];
  const input: ProposalInput = {
    summary: "Implement the feature",
    startEntryId: "u1",
    endEntryId: "a1",
    included: ["implementation"],
    excluded: ["unrelated follow-up"],
    rationale: "The selected turn completes the requested change.",
    evidenceEntryIds: ["u1", "a1"],
    confidence: "high",
  };
  return { sourcePath, snapshot, range, marker, entries, input };
}

async function pagedReviewFixture(t: TestContext, count: number) {
  const values: unknown[] = [header()];
  let parentId: string | null = null;
  for (let index = 0; index < count; index += 1) {
    const id = `u${index}`;
    values.push(user(id, parentId, index));
    parentId = id;
  }
  const sourcePath = await writeSession(t, values);
  const snapshot = await loadSourceSnapshot(sourcePath);
  const marker = buildSourceReference(snapshot, projectionDigest(buildSessionProjection(snapshot)));
  return { sourcePath, entries: [custom(SOURCE_ENTRY_TYPE, marker)] };
}

async function writeReviewSession(
  t: TestContext,
  marker: unknown,
  proposal?: unknown,
  confirmation?: unknown,
): Promise<string> {
  const values: Record<string, unknown>[] = [
    header(3, { id: "review-session" }),
    entry("custom", "review-source", null, 1, { customType: SOURCE_ENTRY_TYPE, data: marker }),
    user("review-user", "review-source", 2, "review task"),
    assistant("review-assistant", "review-user", 3),
  ];
  if (proposal !== undefined) {
    values.push(entry("custom", "review-proposal", "review-assistant", 4, {
      customType: "efficiency:proposal", data: proposal,
    }));
  }
  if (confirmation !== undefined) {
    values.push(entry("custom", "review-confirmation", "review-proposal", 5, {
      customType: "efficiency:confirmation", data: confirmation,
    }));
  }
  return writeSession(t, values);
}

function productionToolContext(
  reviewPath: string | undefined,
  sessionId: string,
  memoryEntries: SessionEntry[],
) {
  return {
    ...toolContext(memoryEntries),
    sessionManager: {
      getBranch: () => memoryEntries,
      getSessionFile: () => reviewPath,
      getSessionId: () => sessionId,
    },
  };
}

function expectCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof TaskEfficiencyError && error.code === code;
}

function proposalRecordCount(entries: readonly SessionEntry[]): number {
  return entries.filter((entry) => {
    const customType = (entry as { readonly customType?: string }).customType;
    return customType === "efficiency:proposal" || customType === "efficiency:revision"
      || customType === "efficiency:confirmation";
  }).length;
}

function customRecordCount(entries: readonly SessionEntry[], customType: string): number {
  return entries.filter((entry) => (entry as { readonly customType?: string }).customType === customType).length;
}

function sessionInfo(path: string, name?: string): SessionInfo {
  return {
    path,
    id: path,
    cwd: "/workspace/current",
    name,
    created: NOW,
    modified: NOW,
    messageCount: 1,
    firstMessage: "first message",
    allMessagesText: "first message",
  };
}

test("命令仅列出当前 cwd 的非复盘 session，并创建隔离复盘 session", async (t) => {
  const sourcePath = await writeSession(t, [header(), user("u1", null, 0), assistant("a1", "u1", 1)]);
  const original = await readFile(sourcePath, "utf8");
  const entries: SessionEntry[] = [];
  const listCalls: string[] = [];
  const { commands } = runtime(entries, {
    listSessions: async (cwd: string) => {
      listCalls.push(cwd);
      return [sessionInfo(sourcePath), sessionInfo("/review.jsonl", `${REVIEW_NAME_PREFIX}old`)];
    },
    now: () => NOW,
  });
  const command = commands.get("efficiency");
  const setupEntries: Array<{ type: string; data?: unknown; name?: string }> = [];
  const sent: Array<{ message: string; options: unknown }> = [];
  const uiOptions: string[][] = [];
  let waited = 0;
  let newSessionOptions: Record<string, unknown> | undefined;
  const oldContext = {
    cwd: "/workspace/current",
    hasUI: true,
    waitForIdle: async () => { waited += 1; },
    ui: {
      select: async (_title: string, options: string[]) => {
        uiOptions.push(options);
        return options[0];
      },
      notify: () => {},
    },
    newSession: async (options: any) => {
      newSessionOptions = options;
      await options.setup({
        appendSessionInfo: (name: string) => setupEntries.push({ type: "session_info", name }),
        appendCustomEntry: (type: string, data: unknown) => setupEntries.push({ type, data }),
      });
      await options.withSession({
        sendUserMessage: async (message: string, options: unknown) => { sent.push({ message, options }); },
      });
      return { cancelled: false };
    },
  };

  await command.handler("", oldContext);

  assert.equal(waited, 1);
  assert.deepEqual(listCalls, ["/workspace/current"]);
  assert.equal(uiOptions[0].length, 1);
  assert.ok(!Object.hasOwn(newSessionOptions!, "parentSession"));
  assert.equal(setupEntries[0].name, `${REVIEW_NAME_PREFIX}session-test`);
  assert.equal(setupEntries.filter((entry) => entry.type === SOURCE_ENTRY_TYPE).length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message, "/skill:analyze-efficiency");
  assert.deepEqual(sent[0].options, { expandPromptTemplates: true });
  assert.ok(!sent[0].message.includes(sourcePath));
  assert.equal(await readFile(sourcePath, "utf8"), original);
});

test("命令将创建、setup 和 replacement 启动失败收敛为稳定错误", async (t) => {
  const sourcePath = await writeSession(t, [header(), user("u1", null, 0), assistant("a1", "u1", 1)]);
  const original = await readFile(sourcePath, "utf8");
  const publicMessage = "[TASK_EFFICIENCY_INTERNAL] Task efficiency review could not continue.";

  for (const stage of ["newSession", "setup", "withSession"] as const) {
    const sentinel = `private-${stage}-${sourcePath}`;
    const notifications: Array<{ message: string; type: string | undefined }> = [];
    let setupCalls = 0;
    let withSessionCalls = 0;
    let sendAttempts = 0;
    const { commands } = runtime([], {
      listSessions: async () => [sessionInfo(sourcePath)],
      now: () => NOW,
    });

    await assert.doesNotReject(() => commands.get("efficiency").handler("", {
      cwd: "/workspace/current",
      hasUI: true,
      waitForIdle: async () => {},
      ui: {
        select: async (_title: string, options: string[]) => options[0],
        notify: (message: string, type?: string) => notifications.push({ message, type }),
      },
      newSession: async (options: any) => {
        if (stage === "newSession") throw new Error(sentinel);
        setupCalls += 1;
        await options.setup({
          appendSessionInfo: () => {},
          appendCustomEntry: () => {
            if (stage === "setup") throw new Error(sentinel);
          },
        });
        withSessionCalls += 1;
        await options.withSession({
          sendUserMessage: async () => {
            sendAttempts += 1;
            if (stage === "withSession") throw new Error(sentinel);
          },
        });
        return { cancelled: false };
      },
    }));

    assert.deepEqual(notifications, [{ message: publicMessage, type: "error" }]);
    assert.ok(!notifications[0].message.includes(sentinel));
    assert.ok(!notifications[0].message.includes(sourcePath));
    assert.equal(setupCalls, stage === "newSession" ? 0 : 1);
    assert.equal(withSessionCalls, stage === "withSession" ? 1 : 0);
    assert.equal(sendAttempts, stage === "withSession" ? 1 : 0);
    assert.equal(await readFile(sourcePath, "utf8"), original);
  }

  const brokenUi = runtime([], { listSessions: async () => [sessionInfo(sourcePath)], now: () => NOW });
  await assert.doesNotReject(() => brokenUi.commands.get("efficiency").handler("", {
    cwd: "/workspace/current",
    hasUI: true,
    waitForIdle: async () => {},
    ui: {
      select: async (_title: string, options: string[]) => options[0],
      notify: () => { throw new Error("notification failed"); },
    },
    newSession: async () => { throw new Error(`private-new-session-${sourcePath}`); },
  }));
  assert.equal(await readFile(sourcePath, "utf8"), original);
});

test("命令排除改名但带 source marker 的复盘 session", async (t) => {
  const sourcePath = await writeSession(t, [header(), user("u1", null, 0), assistant("a1", "u1", 1)]);
  const renamedReviewPath = await writeSession(t, [
    header(),
    user("review-u1", null, 0),
    assistant("review-a1", "review-u1", 1),
    entry("custom", "review-source", "review-a1", 2, { customType: SOURCE_ENTRY_TYPE, data: {} }),
  ]);
  const options: string[][] = [];
  let created = 0;
  const { commands } = runtime([], {
    listSessions: async () => [sessionInfo(sourcePath), sessionInfo(renamedReviewPath, "renamed review")],
    now: () => NOW,
  });

  await commands.get("efficiency").handler("", {
    cwd: "/workspace/current",
    hasUI: true,
    waitForIdle: async () => {},
    ui: {
      select: async (_title: string, choices: string[]) => {
        options.push(choices);
        return choices[0];
      },
      notify: () => {},
    },
    newSession: async () => {
      created += 1;
      return { cancelled: false };
    },
  });

  assert.equal(options[0].length, 1);
  assert.equal(created, 1);
});

test("候选 marker 扫描的错误或漏判都会在最终严格门禁阻断", async (t) => {
  const markedPath = await writeSession(t, [
    header(),
    user("u1", null, 0),
    entry("custom", "review-source", "u1", 1, { customType: SOURCE_ENTRY_TYPE, data: {} }),
    assistant("a1", "u1", 2),
  ]);

  for (const hasReviewMarker of [
    async () => false,
    async () => { throw new Error("scanner unavailable"); },
  ]) {
    let created = 0;
    const notifications: string[] = [];
    const listed: string[][] = [];
    const { commands } = runtime([], {
      listSessions: async () => [sessionInfo(markedPath, "renamed review")],
      hasReviewMarker,
      now: () => NOW,
    });
    await commands.get("efficiency").handler("", {
      cwd: "/workspace/current",
      hasUI: true,
      waitForIdle: async () => {},
      ui: {
        select: async (_title: string, options: string[]) => {
          listed.push(options);
          return options[0];
        },
        notify: (message: string) => notifications.push(message),
      },
      newSession: async () => {
        created += 1;
        return { cancelled: false };
      },
    });
    assert.equal(listed[0].length, 1);
    assert.equal(created, 0);
    assert.match(notifications[0], /SOURCE_UNAVAILABLE/);
  }
});

test("流式 marker 扫描不将嵌套正文误判为复盘 session", async (t) => {
  const sourcePath = await writeSession(t, [
    header(),
    user("u1", null, 0, '{"type":"custom","customType":"efficiency:source"}'),
    entry("custom", "metadata", "u1", 1, {
      customType: "other:record",
      data: { type: "custom", customType: SOURCE_ENTRY_TYPE },
    }),
    assistant("a1", "metadata", 2),
  ]);
  let created = 0;
  const { commands } = runtime([], { listSessions: async () => [sessionInfo(sourcePath)], now: () => NOW });

  await commands.get("efficiency").handler("", {
    cwd: "/workspace/current",
    hasUI: true,
    waitForIdle: async () => {},
    ui: { select: async (_title: string, options: string[]) => options[0], notify: () => {} },
    newSession: async () => {
      created += 1;
      return { cancelled: false };
    },
  });

  assert.equal(created, 1);
});

test("流式 marker 扫描错误保留候选，但最终严格加载阻断", async (t) => {
  const malformedPath = await writeSession(t, [header(), user("u1", null, 0), assistant("a1", "u1", 1)]);
  await writeFile(
    malformedPath,
    `${await readFile(malformedPath, "utf8")}{"type":"custom","customType":"efficiency:source"\n`,
  );
  const options: string[][] = [];
  const notifications: string[] = [];
  let created = 0;
  const { commands } = runtime([], { listSessions: async () => [sessionInfo(malformedPath)], now: () => NOW });

  await commands.get("efficiency").handler("", {
    cwd: "/workspace/current",
    hasUI: true,
    waitForIdle: async () => {},
    ui: {
      select: async (_title: string, choices: string[]) => {
        options.push(choices);
        return choices[0];
      },
      notify: (message: string) => notifications.push(message),
    },
    newSession: async () => {
      created += 1;
      return { cancelled: false };
    },
  });

  assert.equal(options[0].length, 1);
  assert.equal(created, 0);
  assert.match(notifications[0], /SOURCE_UNAVAILABLE/);
});

test("marker 扫描保持原顺序且并发不超过固定上限", async () => {
  const sessions = [
    sessionInfo("/prefixed", `${REVIEW_NAME_PREFIX}old`),
    ...Array.from({ length: 9 }, (_value, index) => sessionInfo(`/session-${index}`, `source ${index}`)),
  ];
  let active = 0;
  let maximum = 0;
  const scanned: string[] = [];
  const options: string[][] = [];
  const { commands } = runtime([], {
    listSessions: async () => sessions,
    hasReviewMarker: async (sourcePath: string) => {
      active += 1;
      maximum = Math.max(maximum, active);
      scanned.push(sourcePath);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return sourcePath === "/session-3";
    },
  });

  await commands.get("efficiency").handler("", {
    cwd: "/workspace/current",
    hasUI: true,
    waitForIdle: async () => {},
    ui: {
      select: async (_title: string, choices: string[]) => {
        options.push(choices);
        return undefined;
      },
      notify: () => {},
    },
    newSession: async () => ({ cancelled: false }),
  });

  assert.equal(scanned.includes("/prefixed"), false);
  assert.equal(scanned.length, 9);
  assert.ok(maximum <= 4);
  assert.deepEqual(options[0].map((option) => option.split(" · ")[0]), [
    "1. source 0", "2. source 1", "3. source 2", "4. source 4", "5. source 5", "6. source 6", "7. source 7", "8. source 8",
  ]);
  assert.ok(options[0].every((option) => option.includes("条消息") && option.includes("UTC")));
});

test("命令覆盖空列表和选择取消，且不创建 session", async () => {
  for (const sessions of [[], [sessionInfo("/review.jsonl", `${REVIEW_NAME_PREFIX}old`)]]) {
    const entries: SessionEntry[] = [];
    const { commands } = runtime(entries, { listSessions: async () => sessions });
    let created = 0;
    const notifications: string[] = [];
    await commands.get("efficiency").handler("", {
      cwd: "/workspace/current",
      hasUI: true,
      waitForIdle: async () => {},
      ui: { select: async () => undefined, notify: (message: string) => notifications.push(message) },
      newSession: async () => { created += 1; return { cancelled: false }; },
    });
    assert.equal(created, 0);
    assert.equal(notifications.length, 1);
  }
});

test("提案使用确定性 ID，并严格校验证据和连续范围", async (t) => {
  const first = await reviewFixture(t);
  const firstRuntime = runtime(first.entries, { now: () => NOW });
  const firstResult = await firstRuntime.tools.get("efficiency_propose_scope")!.execute(
    "call", first.input, undefined, undefined, toolContext(first.entries, ["确认范围"]),
  );
  const firstProposal = first.entries.find((entry: any) => entry.customType === "efficiency:proposal") as any;

  const second = await reviewFixture(t);
  const secondRuntime = runtime(second.entries, { now: () => new Date("2026-09-07T02:00:00.000Z") });
  await secondRuntime.tools.get("efficiency_propose_scope")!.execute(
    "call", second.input, undefined, undefined, toolContext(second.entries, ["确认范围"]),
  );
  const secondProposal = second.entries.find((entry: any) => entry.customType === "efficiency:proposal") as any;
  assert.equal(firstProposal.data.proposalId, secondProposal.data.proposalId);
  assert.equal(firstProposal.data.startTimestamp, first.range.turns[0].startTimestamp);
  assert.equal(firstProposal.data.endTimestamp, first.range.turns.at(-1)!.endTimestamp);
  assert.equal(firstResult.details.code, "TASK_EFFICIENCY_SCOPE_CONFIRMED");

  for (const invalid of [
    { ...first.input, evidenceEntryIds: ["outside"] },
    { ...first.input, evidenceEntryIds: [] },
    { ...first.input, startEntryId: "a1" },
  ]) {
    const fixture = await reviewFixture(t);
    const instance = runtime(fixture.entries, { now: () => NOW });
    await assert.rejects(
      instance.tools.get("efficiency_propose_scope")!.execute("call", invalid, undefined, undefined, toolContext(fixture.entries)),
      expectCode("TASK_EFFICIENCY_PROPOSAL_INVALID"),
    );
    assert.equal(fixture.entries.length, 1);
  }
});

test("提案的确认、修正、重新选择和取消都遵守持久化门禁", async (t) => {
  const confirmFixture = await reviewFixture(t);
  const confirmRuntime = runtime(confirmFixture.entries, { now: () => NOW });
  await confirmRuntime.tools.get("efficiency_propose_scope")!.execute(
    "call", confirmFixture.input, undefined, undefined, toolContext(confirmFixture.entries, ["确认范围"]),
  );
  assert.equal(proposalRecordCount(confirmFixture.entries), 2);

  const reviseFixture = await reviewFixture(t);
  const reviseRuntime = runtime(reviseFixture.entries, { now: () => NOW });
  const correction = "Use only the implementation turn";
  const reviseResult = await reviseRuntime.tools.get("efficiency_propose_scope")!.execute(
    "call", reviseFixture.input, undefined, undefined, toolContext(reviseFixture.entries, ["修正范围"], [correction]),
  );
  assert.match(reviseResult.content[0].text, /complete new proposal/);
  assert.match(reviseResult.content[0].text, new RegExp(correction));
  assert.equal(proposalRecordCount(reviseFixture.entries), 2);

  for (const action of ["重新选择会话", "取消复盘"]) {
    const fixture = await reviewFixture(t);
    const instance = runtime(fixture.entries, { now: () => NOW });
    const result = await instance.tools.get("efficiency_propose_scope")!.execute(
      "call", fixture.input, undefined, undefined, toolContext(fixture.entries, [action]),
    );
    assert.equal(result.terminate, true);
    assert.equal(customRecordCount(fixture.entries, "efficiency:proposal"), 1);
    assert.equal(customRecordCount(fixture.entries, "efficiency:termination"), 1);
    assert.equal(proposalRecordCount(fixture.entries), 1);
  }
});

test("选择取消形成终态，修正输入取消保留 open proposal", async (t) => {
  const selectFailure = await reviewFixture(t);
  const failedContext = toolContext(selectFailure.entries);
  failedContext.ui.select = async () => { throw new Error("dialog failed"); };
  const failedRuntime = runtime(selectFailure.entries, { now: () => NOW });
  await assert.rejects(
    failedRuntime.tools.get("efficiency_propose_scope")!.execute(
      "call", selectFailure.input, undefined, undefined, failedContext,
    ),
    expectCode("TASK_EFFICIENCY_INTERNAL"),
  );
  assert.equal(customRecordCount(selectFailure.entries, "efficiency:proposal"), 1);
  assert.equal(customRecordCount(selectFailure.entries, "efficiency:confirmation"), 0);

  for (const action of [undefined, "取消复盘", "重新选择会话"] as const) {
    const fixture = await reviewFixture(t);
    const instance = runtime(fixture.entries, { now: () => NOW });
    await instance.tools.get("efficiency_propose_scope")!.execute(
      "call", fixture.input, undefined, undefined, toolContext(fixture.entries, [action]),
    );
    assert.equal(customRecordCount(fixture.entries, "efficiency:proposal"), 1);
    assert.equal(customRecordCount(fixture.entries, "efficiency:confirmation"), 0);
    assert.equal(customRecordCount(fixture.entries, "efficiency:revision"), 0);
    assert.equal(customRecordCount(fixture.entries, "efficiency:termination"), 1);
  }

  for (const correction of [undefined, "", "  "] as const) {
    const fixture = await reviewFixture(t);
    const instance = runtime(fixture.entries, { now: () => NOW });
    await assert.rejects(
      instance.tools.get("efficiency_propose_scope")!.execute(
        "call", fixture.input, undefined, undefined, toolContext(fixture.entries, ["修正范围"], [correction]),
      ),
      expectCode("TASK_EFFICIENCY_PROPOSAL_INVALID"),
    );
    assert.equal(customRecordCount(fixture.entries, "efficiency:proposal"), 1);
    assert.equal(customRecordCount(fixture.entries, "efficiency:confirmation"), 0);
    assert.equal(customRecordCount(fixture.entries, "efficiency:revision"), 0);
    assert.equal(customRecordCount(fixture.entries, "efficiency:termination"), 0);
  }
});

test("缺失、多个或无效 source marker 均失败关闭", async (t) => {
  const fixture = await reviewFixture(t);
  const invalid = { ...fixture.marker, sourcePath: "relative.jsonl" };
  for (const entries of [
    [] as SessionEntry[],
    [custom(SOURCE_ENTRY_TYPE, invalid)],
    [custom(SOURCE_ENTRY_TYPE, fixture.marker), custom(SOURCE_ENTRY_TYPE, fixture.marker, 1)],
  ]) {
    const instance = runtime(entries, { now: () => NOW });
    await assert.rejects(
      instance.tools.get("efficiency_analyze")!.execute("call", {}, undefined, undefined, toolContext(entries)),
      expectCode("TASK_EFFICIENCY_REVIEW_STATE_INVALID"),
    );
  }
});

test("源在提案前变化、确认后变化和分析前变化时均不写后续记录", async (t) => {
  const before = await reviewFixture(t);
  await writeFile(before.sourcePath, `${await readFile(before.sourcePath, "utf8")}${JSON.stringify(user("u2", "a1", 3))}\n`);
  const beforeRuntime = runtime(before.entries, { now: () => NOW });
  await assert.rejects(
    beforeRuntime.tools.get("efficiency_propose_scope")!.execute("call", before.input, undefined, undefined, toolContext(before.entries)),
    expectCode("TASK_EFFICIENCY_SOURCE_STALE"),
  );
  assert.equal(before.entries.length, 1);

  const after = await reviewFixture(t);
  const afterRuntime = runtime(after.entries, { now: () => NOW });
  await afterRuntime.tools.get("efficiency_propose_scope")!.execute(
    "call", after.input, undefined, undefined, toolContext(after.entries, ["确认范围"]),
  );
  await writeFile(after.sourcePath, `${await readFile(after.sourcePath, "utf8")}${JSON.stringify(user("u2", "a1", 3))}\n`);
  await assert.rejects(
    afterRuntime.tools.get("efficiency_analyze")!.execute("call", {}, undefined, undefined, toolContext(after.entries)),
    expectCode("TASK_EFFICIENCY_SOURCE_STALE"),
  );
  assert.equal(after.entries.filter((entry: any) => entry.customType === "efficiency:report").length, 0);
});

test("无确认、文字确认和最新 revision 后无新提案均不能分析", async (t) => {
  const noConfirmation = await reviewFixture(t);
  const instance = runtime(noConfirmation.entries, { now: () => NOW });
  noConfirmation.entries.push({
    type: "message",
    id: "text-confirmation",
    parentId: null,
    timestamp: NOW.toISOString(),
    message: { role: "assistant", content: [{ type: "text", text: "The user confirmed the scope." }] },
  } as unknown as SessionEntry);
  await assert.rejects(
    instance.tools.get("efficiency_analyze")!.execute("call", {}, undefined, undefined, toolContext(noConfirmation.entries)),
    expectCode("TASK_EFFICIENCY_CONFIRMATION_REQUIRED"),
  );

  const revised = await reviewFixture(t);
  const proposal = createProposal(revised.input, revised.snapshot, revised.range, NOW);
  revised.entries.push(custom("efficiency:proposal", proposal, 1));
  revised.entries.push(custom("efficiency:revision", revisionForProposal(proposal.proposalId, "Narrow it", NOW), 2));
  const revisedRuntime = runtime(revised.entries, { now: () => NOW });
  await assert.rejects(
    revisedRuntime.tools.get("efficiency_analyze")!.execute("call", {}, undefined, undefined, toolContext(revised.entries)),
    expectCode("TASK_EFFICIENCY_CONFIRMATION_REQUIRED"),
  );
});

test("分析无范围参数、只持久化紧凑 marker，且不泄露复盘路径或工具正文", async (t) => {
  const fixture = await reviewFixture(t);
  const instance = runtime(fixture.entries, { now: () => NOW });
  const propose = instance.tools.get("efficiency_propose_scope")!;
  const analyze = instance.tools.get("efficiency_analyze")!;
  assert.equal(analyze.parameters.additionalProperties, false);
  await propose.execute("call", fixture.input, undefined, undefined, toolContext(fixture.entries, ["确认范围"]));
  const result = await analyze.execute("call", {}, undefined, undefined, toolContext(fixture.entries));
  const report = JSON.parse(result.content[0].text);
  const marker = (fixture.entries.at(-1) as any).data;

  assert.equal((fixture.entries.at(-1) as any).customType, "efficiency:report");
  assert.deepEqual(Object.keys(marker).sort(), [
    "createdAt", "endEntryId", "proposalId", "reportDigest", "schemaVersion", "sourceDigest", "startEntryId",
  ]);
  assert.equal(result.details.code, "TASK_EFFICIENCY_REPORT_READY");
  assert.equal(Object.hasOwn(result.details, "report"), false);
  assert.equal(JSON.stringify(marker).includes(fixture.sourcePath), false);
  assert.equal(result.content[0].text.includes(fixture.sourcePath), false);
  assert.equal(JSON.stringify(report).includes("efficiency:review"), false);
  await assert.rejects(
    analyze.execute("call", {}, undefined, undefined, toolContext(fixture.entries)),
    expectCode("TASK_EFFICIENCY_ANALYSIS_NOT_READY"),
  );
  await assert.rejects(
    propose.execute("call", fixture.input, undefined, undefined, toolContext(fixture.entries, ["确认范围"])),
    expectCode("TASK_EFFICIENCY_REVIEW_STATE_INVALID"),
  );
  assert.equal(fixture.entries.filter((entry: any) => entry.customType === "efficiency:report").length, 1);

  const proposal = (fixture.entries.find((entry: any) => entry.customType === "efficiency:proposal") as any)!.data;
  for (const record of [
    custom("efficiency:revision", revisionForProposal(proposal.proposalId, "Narrow scope", NOW), 50),
    custom("efficiency:confirmation", confirmationForProposal(proposal, NOW), 51),
  ]) {
    const invalidEntries = [...fixture.entries, record];
    const invalidRuntime = runtime(invalidEntries, { now: () => NOW });
    await assert.rejects(
      invalidRuntime.tools.get("efficiency_analyze")!.execute(
        "call", {}, undefined, undefined, toolContext(invalidEntries),
      ),
      expectCode("TASK_EFFICIENCY_REVIEW_STATE_INVALID"),
    );
  }
});

test("report append 失败后主 review 状态保持 fail-closed", async (t) => {
  const fixture = await reviewFixture(t);
  const proposal = createProposal(fixture.input, fixture.snapshot, fixture.range, NOW);
  fixture.entries.push(custom("efficiency:proposal", proposal, 1));
  fixture.entries.push(custom("efficiency:confirmation", confirmationForProposal(proposal, NOW), 2));
  const instance = runtime(fixture.entries, { now: () => NOW }, () => {
    throw new Error("report append failed");
  });
  const analyze = instance.tools.get("efficiency_analyze")!;
  await assert.rejects(
    analyze.execute("call", {}, undefined, undefined, toolContext(fixture.entries)),
    expectCode("TASK_EFFICIENCY_INTERNAL"),
  );
  await assert.rejects(
    analyze.execute("call", {}, undefined, undefined, toolContext(fixture.entries)),
    expectCode("TASK_EFFICIENCY_INTERNAL"),
  );
  assert.equal(customRecordCount(fixture.entries, "efficiency:report"), 0);
});

test("无 UI 时四个工具均以稳定公开错误失败", async (t) => {
  const fixture = await reviewFixture(t);
  const instance = runtime(fixture.entries, { now: () => NOW });
  const context = { hasUI: false, sessionManager: { getBranch: () => fixture.entries } };
  for (const [name, input] of [
    ["efficiency_read_scope_page", {}],
    ["efficiency_expand_scope", { startEntryId: "u1", endEntryId: "a1" }],
    ["efficiency_propose_scope", fixture.input],
    ["efficiency_analyze", {}],
  ] as const) {
    await assert.rejects(
      instance.tools.get(name)!.execute("call", input, undefined, undefined, context),
      expectCode("TASK_EFFICIENCY_UI_REQUIRED"),
    );
  }
});

test("紧凑投影可按需有界展开，且确认 UI 使用本地化事实摘要", async (t) => {
  const fixture = await reviewFixture(t);
  const instance = runtime(fixture.entries, { now: () => NOW });
  const detailResult = await instance.tools.get("efficiency_expand_scope")!.execute(
    "call",
    { startEntryId: "u1", endEntryId: "a1" },
    undefined,
    undefined,
    toolContext(fixture.entries),
  );
  const detail = JSON.parse(detailResult.content[0].text);
  assert.equal(detailResult.details.code, "TASK_EFFICIENCY_SCOPE_DETAIL");
  assert.deepEqual(detail.entries.map((entry: any) => entry.kind), ["user", "assistant"]);

  const context = toolContext(fixture.entries);
  context.ui.select = async (title: string, options: string[]) => {
    assert.match(title, /确认任务范围/);
    assert.match(title, /1 个用户回合/);
    assert.match(title, /UTC/);
    assert.deepEqual(options, ["确认范围", "修正范围", "重新选择会话", "取消复盘"]);
    return options[0];
  };
  await instance.tools.get("efficiency_propose_scope")!.execute(
    "call", fixture.input, undefined, undefined, context,
  );
  await assert.rejects(
    instance.tools.get("efficiency_expand_scope")!.execute(
      "call",
      { startEntryId: "u1", endEntryId: "a1" },
      undefined,
      undefined,
      toolContext(fixture.entries),
    ),
    expectCode("TASK_EFFICIENCY_SCOPE_DETAIL_INVALID"),
  );
});

test("范围页工具默认返回最新页并可按 previousCursor 向前翻页", async (t) => {
  const fixture = await pagedReviewFixture(t, 100);
  const instance = runtime(fixture.entries, { now: () => NOW });
  const pageTool = instance.tools.get("efficiency_read_scope_page")!;
  assert.equal(pageTool.parameters.additionalProperties, false);
  assert.equal(pageTool.parameters.properties?.beforeCursor?.type, "integer");

  const latestResult = await pageTool.execute("call", {}, undefined, undefined, toolContext(fixture.entries));
  const latest = JSON.parse(latestResult.content[0].text);
  assert.equal(latestResult.details.code, "TASK_EFFICIENCY_SCOPE_PAGE");
  assert.equal(latest.totalEntries, 100);
  assert.equal(latest.startCursor, 20);
  assert.equal(latest.endCursor, 100);
  assert.equal(latest.previousCursor, 20);
  assert.equal(latest.entries.length, 80);
  assert.equal(latest.entries[0].sourceEntryId, "u20");
  assert.equal(latest.entries.at(-1).sourceEntryId, "u99");
  assert.equal(Object.hasOwn(latest, "source"), true);
  assert.equal(Object.hasOwn(latest, "omitted"), true);
  assert.equal(latestResult.details.previousCursor, 20);

  const earlier = JSON.parse((await pageTool.execute(
    "call", { beforeCursor: latest.previousCursor }, undefined, undefined, toolContext(fixture.entries),
  )).content[0].text);
  assert.equal(earlier.totalEntries, 100);
  assert.equal(earlier.startCursor, 0);
  assert.equal(earlier.endCursor, 20);
  assert.equal(earlier.previousCursor, null);
  assert.deepEqual(
    earlier.entries.map((entry: any) => entry.sourceEntryId),
    Array.from({ length: 20 }, (_value, index) => `u${index}`),
  );

  const combined = [...earlier.entries, ...latest.entries].map((entry: any) => entry.sourceEntryId);
  assert.deepEqual(combined, Array.from({ length: 100 }, (_value, index) => `u${index}`));
  assert.equal(new Set(combined).size, 100);

  await assert.rejects(
    pageTool.execute("call", { beforeCursor: 101 }, undefined, undefined, toolContext(fixture.entries)),
    expectCode("TASK_EFFICIENCY_SCOPE_PAGE_INVALID"),
  );
  await assert.rejects(
    pageTool.execute("call", { beforeCursor: -1 }, undefined, undefined, toolContext(fixture.entries)),
    expectCode("TASK_EFFICIENCY_SCOPE_PAGE_INVALID"),
  );
});

test("范围页工具只在 empty/revised 阶段工作且每次校验源 freshness", async (t) => {
  const fixture = await reviewFixture(t);
  const instance = runtime(fixture.entries, { now: () => NOW });
  const pageTool = instance.tools.get("efficiency_read_scope_page")!;
  const fresh = JSON.parse((await pageTool.execute(
    "call", {}, undefined, undefined, toolContext(fixture.entries),
  )).content[0].text);
  assert.equal(fresh.totalEntries, 2);

  const revised = await reviewFixture(t);
  const revisedRuntime = runtime(revised.entries, { now: () => NOW });
  await revisedRuntime.tools.get("efficiency_propose_scope")!.execute(
    "call", revised.input, undefined, undefined, toolContext(revised.entries, ["修正范围"], ["Narrow scope"]),
  );
  await assert.doesNotReject(
    revisedRuntime.tools.get("efficiency_read_scope_page")!.execute(
      "call", {}, undefined, undefined, toolContext(revised.entries),
    ),
  );

  const open = await reviewFixture(t);
  const openContext = toolContext(open.entries);
  openContext.ui.select = async () => { throw new Error("dialog unavailable"); };
  const openRuntime = runtime(open.entries, { now: () => NOW });
  await assert.rejects(
    openRuntime.tools.get("efficiency_propose_scope")!.execute(
      "call", open.input, undefined, undefined, openContext,
    ),
    expectCode("TASK_EFFICIENCY_INTERNAL"),
  );
  await assert.rejects(
    openRuntime.tools.get("efficiency_read_scope_page")!.execute(
      "call", {}, undefined, undefined, toolContext(open.entries),
    ),
    expectCode("TASK_EFFICIENCY_SCOPE_PAGE_INVALID"),
  );

  const confirmed = await reviewFixture(t);
  const confirmedRuntime = runtime(confirmed.entries, { now: () => NOW });
  await confirmedRuntime.tools.get("efficiency_propose_scope")!.execute(
    "call", confirmed.input, undefined, undefined, toolContext(confirmed.entries, ["确认范围"]),
  );
  await assert.rejects(
    confirmedRuntime.tools.get("efficiency_read_scope_page")!.execute(
      "call", {}, undefined, undefined, toolContext(confirmed.entries),
    ),
    expectCode("TASK_EFFICIENCY_SCOPE_PAGE_INVALID"),
  );
  await confirmedRuntime.tools.get("efficiency_analyze")!.execute(
    "call", {}, undefined, undefined, toolContext(confirmed.entries),
  );
  await assert.rejects(
    confirmedRuntime.tools.get("efficiency_read_scope_page")!.execute(
      "call", {}, undefined, undefined, toolContext(confirmed.entries),
    ),
    expectCode("TASK_EFFICIENCY_SCOPE_PAGE_INVALID"),
  );

  const terminated = await reviewFixture(t);
  const terminatedRuntime = runtime(terminated.entries, { now: () => NOW });
  await terminatedRuntime.tools.get("efficiency_propose_scope")!.execute(
    "call", terminated.input, undefined, undefined, toolContext(terminated.entries, ["重新选择会话"]),
  );
  await assert.rejects(
    terminatedRuntime.tools.get("efficiency_read_scope_page")!.execute(
      "call", {}, undefined, undefined, toolContext(terminated.entries),
    ),
    expectCode("TASK_EFFICIENCY_SCOPE_PAGE_INVALID"),
  );

  const stale = await reviewFixture(t);
  const staleRuntime = runtime(stale.entries, { now: () => NOW });
  await writeFile(stale.sourcePath, `${await readFile(stale.sourcePath, "utf8")}${JSON.stringify(user("u2", "a1", 3))}\n`);
  await assert.rejects(
    staleRuntime.tools.get("efficiency_read_scope_page")!.execute(
      "call", {}, undefined, undefined, toolContext(stale.entries),
    ),
    expectCode("TASK_EFFICIENCY_SOURCE_STALE"),
  );
});

test("agent_settled 仅为已报告 review 持久化并显示一次独立 overhead", async (t) => {
  const fixture = await reviewFixture(t);
  const proposal = createProposal(fixture.input, fixture.snapshot, fixture.range, NOW);
  fixture.entries.push(custom("efficiency:proposal", proposal, 1));
  fixture.entries.push(custom("efficiency:confirmation", confirmationForProposal(proposal, NOW), 2));
  fixture.entries.push(custom("efficiency:report", compactReportMarker(proposal, "{}", NOW), 3));
  const overhead: ReviewOverhead = {
    schemaVersion: 1,
    reviewSessionId: "review-session",
    startEntryId: "review-user",
    endEntryId: "review-assistant",
    wallClockSpanSeconds: 4,
    modelResponses: 3,
    toolCalls: 2,
    kickoffBytes: 12_345,
    sessionBytes: 23_456,
    tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 0, reasoning: null, totalTokens: 60 },
    cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0, total: 0.6 },
    coverage: {
      timeComplete: true,
      usageComplete: true,
      costComplete: true,
      reasoningComplete: false,
      requiredMetricsComplete: true,
    },
  };
  let loads = 0;
  let overheadBuilds = 0;
  let releaseLoad: (() => void) | undefined;
  const loadBarrier = new Promise<void>((resolve) => { releaseLoad = resolve; });
  const instance = runtime(fixture.entries, {
    loadSnapshot: async () => {
      loads += 1;
      await loadBarrier;
      return {
        sessionId: "review-session",
        activeBranch: fixture.entries.map((raw, index) => ({ id: `entry-${index}`, raw })),
      } as unknown as SourceSnapshot;
    },
    buildOverhead: async () => {
      overheadBuilds += 1;
      return overhead;
    },
    now: () => NOW,
  });
  const notifications: string[] = [];
  const context = {
    hasUI: true,
    ui: { notify: (message: string) => notifications.push(message) },
    sessionManager: {
      getBranch: () => fixture.entries,
      getSessionFile: () => "/review.jsonl",
      getSessionId: () => "review-session",
    },
  };
  const firstSettled = instance.handlers.get("agent_settled")!({}, context);
  const secondSettled = instance.handlers.get("agent_settled")!({}, context);
  assert.equal(loads, 1);
  releaseLoad!();
  await Promise.all([firstSettled, secondSettled]);
  await instance.handlers.get("agent_settled")!({}, context);

  assert.equal(loads, 1);
  assert.equal(overheadBuilds, 1);
  assert.equal(customRecordCount(fixture.entries, "efficiency:review-overhead"), 1);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /不计入源任务/);
  assert.match(notifications[0], /模型响应：3/);
  assert.match(notifications[0], /reasoning 不可核实/);

  const retryFixture = await reviewFixture(t);
  const retryProposal = createProposal(retryFixture.input, retryFixture.snapshot, retryFixture.range, NOW);
  retryFixture.entries.push(custom("efficiency:proposal", retryProposal, 1));
  retryFixture.entries.push(custom("efficiency:confirmation", confirmationForProposal(retryProposal, NOW), 2));
  retryFixture.entries.push(custom("efficiency:report", compactReportMarker(retryProposal, "{}", NOW), 3));
  let appendAttempts = 0;
  const retryRuntime = runtime(retryFixture.entries, {
    loadSnapshot: async () => ({
      sessionId: "review-session",
      activeBranch: retryFixture.entries.map((raw, index) => ({ id: `entry-${index}`, raw })),
    }) as unknown as SourceSnapshot,
    buildOverhead: async () => overhead,
    now: () => NOW,
  }, (customType, data) => {
    appendAttempts += 1;
    if (appendAttempts === 1) throw new Error("temporary append failure");
    retryFixture.entries.push(custom(customType, data, retryFixture.entries.length));
  });
  const retryNotifications: Array<{ message: string; type?: string }> = [];
  const retryContext = {
    hasUI: true,
    ui: { notify: (message: string, type?: string) => retryNotifications.push({ message, type }) },
    sessionManager: {
      getBranch: () => retryFixture.entries,
      getSessionFile: () => "/review.jsonl",
      getSessionId: () => "review-session",
    },
  };
  await retryRuntime.handlers.get("agent_settled")!({}, retryContext);
  await retryRuntime.handlers.get("agent_settled")!({}, retryContext);
  assert.equal(appendAttempts, 2);
  assert.equal(customRecordCount(retryFixture.entries, "efficiency:review-overhead"), 1);
  assert.deepEqual(retryNotifications.map((item) => item.type), ["warning", "info"]);

  let regularLoads = 0;
  const regular = runtime([], {
    loadSnapshot: async () => {
      regularLoads += 1;
      throw new Error("must not load a regular session");
    },
  });
  await regular.handlers.get("agent_settled")!({}, {
    hasUI: true,
    ui: { notify: () => {} },
    sessionManager: { getBranch: () => [], getSessionFile: () => "/regular.jsonl" },
  });
  assert.equal(regularLoads, 0);
});

test("manifest 与 skill 保持 package discovery 和受控复盘契约", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const skill = await readFile(new URL("../skills/analyze-efficiency/SKILL.md", import.meta.url), "utf8");
  assert.deepEqual(packageJson.pi, { extensions: ["./index.ts"], skills: ["./skills"] });
  assert.deepEqual(packageJson.peerDependencies, {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    typebox: "*",
  });
  assert.equal(packageJson.devDependencies["@earendil-works/pi-ai"], "1.4.0");
  assert.match(skill, /^name: analyze-efficiency$/m);
  assert.match(skill, /\/efficiency/);
  assert.match(skill, /不要读取、扫描或请求原始 session 文件/);
  assert.match(skill, /efficiency_expand_scope/);
  assert.match(skill, /efficiency_read_scope_page/);
  assert.match(skill, /previousCursor/);
  assert.match(skill, /无同类基线的单次证据判断/);
  assert.match(skill, /本地时间.*entry ID/);
  assert.match(skill, /coverage\.complete.*reasoningComplete/);
  assert.match(skill, /reasoning.*output/);
  assert.match(skill, /cacheRead/);
  assert.match(skill, /精确落点（文件或规则位置）、建议类型、负责人和验证方式/);
  assert.match(skill, /现有规则未遵守 \/ 技能或文档缺口 \/ 代码或测试缺口 \/ 证据不足/);
  assert.match(skill, /现有规则已覆盖时应写“执行偏差，无文件改动”/);
  assert.match(skill, /不得建议重复加规则/);
  const proposalSchema = runtime([]).tools.get("efficiency_propose_scope")!.parameters;
  const confidence = proposalSchema.properties?.confidence;
  assert.equal(confidence?.type, "string");
  assert.deepEqual(confidence?.enum, ["high", "medium", "low"]);
  assert.equal(Object.hasOwn(confidence!, "anyOf"), false);
  assert.equal(Object.hasOwn(proposalSchema.properties!, "startTimestamp"), false);
  assert.equal(Object.hasOwn(proposalSchema.properties!, "endTimestamp"), false);
});

test("命令在无 UI、带参数、取消和初始 S0/S1 不一致时不会替换 session", async (t) => {
  const sourcePath = await writeSession(t, [header(), user("u1", null, 0), assistant("a1", "u1", 1)]);
  const noUi = runtime([], { listSessions: async () => { throw new Error("must not list"); } });
  let waited = 0;
  await noUi.commands.get("efficiency").handler("", {
    hasUI: false,
    waitForIdle: async () => { waited += 1; },
  });
  assert.equal(waited, 1);

  const withArgs = runtime([], { listSessions: async () => { throw new Error("must not list"); } });
  const argumentNotifications: string[] = [];
  await withArgs.commands.get("efficiency").handler("unexpected", {
    hasUI: true,
    waitForIdle: async () => {},
    ui: { notify: (message: string) => argumentNotifications.push(message) },
  });
  assert.match(argumentNotifications[0], /不接受参数/);

  const cancelled = runtime([], { listSessions: async () => [sessionInfo(sourcePath)], now: () => NOW });
  const cancellationNotifications: string[] = [];
  await cancelled.commands.get("efficiency").handler("", {
    cwd: "/workspace/current",
    hasUI: true,
    waitForIdle: async () => {},
    ui: { select: async (_title: string, options: string[]) => options[0], notify: (message: string) => cancellationNotifications.push(message) },
    newSession: async () => ({ cancelled: true }),
  });
  assert.deepEqual(cancellationNotifications, ["任务效率复盘已取消。"]);

  let loads = 0;
  let created = 0;
  const stale = runtime([], {
    listSessions: async () => [sessionInfo(sourcePath)],
    loadSnapshot: async (path: string) => {
      const snapshot = await loadSourceSnapshot(path);
      loads += 1;
      if (loads === 1) {
        await writeFile(sourcePath, `${await readFile(sourcePath, "utf8")}${JSON.stringify(user("u2", "a1", 2))}\n`);
      }
      return snapshot;
    },
  });
  const staleNotifications: string[] = [];
  await stale.commands.get("efficiency").handler("", {
    cwd: "/workspace/current",
    hasUI: true,
    waitForIdle: async () => {},
    ui: { select: async (_title: string, options: string[]) => options[0], notify: (message: string) => staleNotifications.push(message) },
    newSession: async () => { created += 1; return { cancelled: false }; },
  });
  assert.equal(loads, 2);
  assert.equal(created, 0);
  assert.match(staleNotifications[0], /SOURCE_STALE/);
});

test("确认 UI 等待期间源变化保留 proposal 但不追加 confirmation", async (t) => {
  const fixture = await reviewFixture(t);
  const instance = runtime(fixture.entries, { now: () => NOW });
  const context = toolContext(fixture.entries);
  context.ui.select = async () => {
    await writeFile(fixture.sourcePath, `${await readFile(fixture.sourcePath, "utf8")}${JSON.stringify(user("u2", "a1", 3))}\n`);
    return "确认范围";
  };
  await assert.rejects(
    instance.tools.get("efficiency_propose_scope")!.execute("call", fixture.input, undefined, undefined, context),
    expectCode("TASK_EFFICIENCY_SOURCE_STALE"),
  );
  assert.equal(customRecordCount(fixture.entries, "efficiency:proposal"), 1);
  assert.equal(customRecordCount(fixture.entries, "efficiency:confirmation"), 0);
});

test("状态机允许修正后的完整历史链，并拒绝未修正重复 proposal 和非法 confirmation", async (t) => {
  const fixture = await reviewFixture(t);
  const proposal1 = createProposal(fixture.input, fixture.snapshot, fixture.range, NOW);
  const proposal2 = createProposal({ ...fixture.input, summary: "Implement the narrowed feature" }, fixture.snapshot, fixture.range, NOW);
  fixture.entries.push(custom("efficiency:proposal", proposal1, 1));
  fixture.entries.push(custom("efficiency:revision", revisionForProposal(proposal1.proposalId, "Narrow scope", NOW), 2));
  fixture.entries.push(custom("efficiency:proposal", proposal2, 3));
  fixture.entries.push(custom("efficiency:confirmation", confirmationForProposal(proposal2, NOW), 4));
  const valid = runtime(fixture.entries, { now: () => NOW });
  const result = await valid.tools.get("efficiency_analyze")!.execute("call", {}, undefined, undefined, toolContext(fixture.entries));
  assert.equal(JSON.parse(result.content[0].text).range.startEntryId, "u1");

  const open = await reviewFixture(t);
  const openProposal = createProposal(open.input, open.snapshot, open.range, NOW);
  open.entries.push(custom("efficiency:proposal", openProposal, 1));
  const openRuntime = runtime(open.entries, { now: () => NOW });
  const entryCount = open.entries.length;
  await assert.rejects(
    openRuntime.tools.get("efficiency_propose_scope")!.execute(
      "call", { ...open.input, summary: "Different proposal" }, undefined, undefined, toolContext(open.entries),
    ),
    expectCode("TASK_EFFICIENCY_REVIEW_STATE_INVALID"),
  );
  assert.equal(open.entries.length, entryCount);

  for (const confirmation of [
    { ...confirmationForProposal(proposal1, NOW), startEntryId: "wrong" },
    confirmationForProposal(proposal1, NOW),
  ]) {
    const invalid = await reviewFixture(t);
    invalid.entries.push(custom("efficiency:proposal", proposal1, 1));
    invalid.entries.push(custom("efficiency:confirmation", confirmationForProposal(proposal1, NOW), 2));
    if (confirmation.startEntryId === "wrong") {
      invalid.entries[2] = custom("efficiency:confirmation", confirmation, 2);
    } else {
      invalid.entries.push(custom("efficiency:confirmation", confirmation, 3));
    }
    const invalidRuntime = runtime(invalid.entries, { now: () => NOW });
    await assert.rejects(
      invalidRuntime.tools.get("efficiency_analyze")!.execute("call", {}, undefined, undefined, toolContext(invalid.entries)),
      expectCode("TASK_EFFICIENCY_REVIEW_STATE_INVALID"),
    );
  }
});

test("confirmation append 失败后可按同一 proposal 恢复", async (t) => {
  const fixture = await reviewFixture(t);
  let appendCalls = 0;
  const failing = runtime(fixture.entries, { now: () => NOW }, (customType, data) => {
    appendCalls += 1;
    if (appendCalls === 2) throw new Error("confirmation append failed");
    fixture.entries.push(custom(customType, data, fixture.entries.length));
  });
  const failedContext = toolContext(fixture.entries, ["确认范围"]);
  await assert.rejects(
    failing.tools.get("efficiency_propose_scope")!.execute(
      "call", fixture.input, undefined, undefined, failedContext,
    ),
    expectCode("TASK_EFFICIENCY_INTERNAL"),
  );
  assert.equal(fixture.entries.filter((entry: any) => entry.customType === "efficiency:proposal").length, 1);
  assert.equal(fixture.entries.filter((entry: any) => entry.customType === "efficiency:confirmation").length, 0);
  await assert.rejects(
    failing.tools.get("efficiency_propose_scope")!.execute(
      "call", fixture.input, undefined, undefined, failedContext,
    ),
    expectCode("TASK_EFFICIENCY_INTERNAL"),
  );

  const retry = runtime(fixture.entries, { now: () => NOW });
  await retry.tools.get("efficiency_propose_scope")!.execute(
    "call", fixture.input, undefined, undefined, toolContext(fixture.entries, ["确认范围"]),
  );
  assert.equal(fixture.entries.filter((entry: any) => entry.customType === "efficiency:proposal").length, 1);
  assert.equal(fixture.entries.filter((entry: any) => entry.customType === "efficiency:confirmation").length, 1);
});

test("revision append 失败后可按同一 proposal 恢复", async (t) => {
  const fixture = await reviewFixture(t);
  let appendCalls = 0;
  const failing = runtime(fixture.entries, { now: () => NOW }, (customType, data) => {
    appendCalls += 1;
    if (appendCalls === 2) throw new Error("revision append failed");
    fixture.entries.push(custom(customType, data, fixture.entries.length));
  });
  const failedContext = toolContext(fixture.entries, ["修正范围"], ["Narrow scope"]);
  await assert.rejects(
    failing.tools.get("efficiency_propose_scope")!.execute(
      "call", fixture.input, undefined, undefined, failedContext,
    ),
    expectCode("TASK_EFFICIENCY_INTERNAL"),
  );
  assert.equal(fixture.entries.filter((entry: any) => entry.customType === "efficiency:proposal").length, 1);
  assert.equal(fixture.entries.filter((entry: any) => entry.customType === "efficiency:revision").length, 0);
  await assert.rejects(
    failing.tools.get("efficiency_propose_scope")!.execute(
      "call", fixture.input, undefined, undefined, failedContext,
    ),
    expectCode("TASK_EFFICIENCY_INTERNAL"),
  );

  const cancelled = runtime(fixture.entries, { now: () => NOW });
  await assert.rejects(
    cancelled.tools.get("efficiency_propose_scope")!.execute(
      "call", fixture.input, undefined, undefined, toolContext(fixture.entries, ["修正范围"], [undefined]),
    ),
    expectCode("TASK_EFFICIENCY_PROPOSAL_INVALID"),
  );
  assert.equal(fixture.entries.filter((entry: any) => entry.customType === "efficiency:proposal").length, 1);

  const retry = runtime(fixture.entries, { now: () => NOW });
  await retry.tools.get("efficiency_propose_scope")!.execute(
    "call", fixture.input, undefined, undefined, toolContext(fixture.entries, ["修正范围"], ["Narrow scope"]),
  );
  assert.equal(fixture.entries.filter((entry: any) => entry.customType === "efficiency:proposal").length, 1);
  assert.equal(fixture.entries.filter((entry: any) => entry.customType === "efficiency:revision").length, 1);
});

test("持久 proposal 的派生时间被篡改时使用稳定 ANALYSIS_NOT_READY 失败关闭", async (t) => {
  const fixture = await reviewFixture(t);
  const proposal = createProposal(fixture.input, fixture.snapshot, fixture.range, NOW);
  const tampered = Object.freeze({
    ...proposal,
    startTimestamp: "2026-09-07T00:00:00.001Z",
    proposalId: proposalId({ ...proposal, startTimestamp: "2026-09-07T00:00:00.001Z" }),
  });
  fixture.entries.push(custom("efficiency:proposal", tampered, 1));
  fixture.entries.push(custom("efficiency:confirmation", confirmationForProposal(tampered, NOW), 2));
  const instance = runtime(fixture.entries, { now: () => NOW });
  await assert.rejects(
    instance.tools.get("efficiency_analyze")!.execute("call", {}, undefined, undefined, toolContext(fixture.entries)),
    expectCode("TASK_EFFICIENCY_ANALYSIS_NOT_READY"),
  );
});

test("模型仅选择 entry 边界，扩展按角色派生持久时间", async (t) => {
  const sourceUser = user("u1", null, 0, "implement the feature") as Record<string, any>;
  const sourceAssistant = assistant("a1", "u1", 2) as Record<string, any>;
  sourceUser.message.timestamp = Date.parse("2026-09-07T00:00:00.005Z");
  sourceAssistant.message.timestamp = Date.parse("2026-09-07T00:00:00.010Z");
  const sourcePath = await writeSession(t, [header(), sourceUser, sourceAssistant]);
  const snapshot = await loadSourceSnapshot(sourcePath);
  const range = validateTaskRange(snapshot, { startEntryId: "u1", endEntryId: "a1" });
  const entries = [custom(SOURCE_ENTRY_TYPE, buildSourceReference(snapshot, projectionDigest(buildSessionProjection(snapshot))))];
  const input: ProposalInput = {
    summary: "Implement the feature",
    startEntryId: "u1",
    endEntryId: "a1",
    included: ["implementation"],
    excluded: [],
    rationale: "The selected turn completes the requested change.",
    evidenceEntryIds: ["u1", "a1"],
    confidence: "high",
  };
  const instance = runtime(entries, { now: () => NOW });
  await instance.tools.get("efficiency_propose_scope")!.execute(
    "call", input, undefined, undefined, toolContext(entries, ["取消复盘"]),
  );
  const proposal = (entries.find((value: any) => value.customType === "efficiency:proposal") as any).data;

  assert.equal(range.turns[0].startTimestamp, "2026-09-07T00:00:00.005Z");
  assert.equal(range.turns.at(-1)!.endTimestamp, "2026-09-07T00:00:02.000Z");
  assert.equal(proposal.startTimestamp, range.turns[0].startTimestamp);
  assert.equal(proposal.endTimestamp, range.turns.at(-1)!.endTimestamp);
});

test("恢复范围错误使用稳定 ANALYSIS_NOT_READY，报告不混入 review usage", async (t) => {
  const fixture = await reviewFixture(t);
  const proposal = createProposal(fixture.input, fixture.snapshot, fixture.range, NOW);
  fixture.entries.push(custom("efficiency:proposal", proposal, 1));
  fixture.entries.push(custom("efficiency:confirmation", confirmationForProposal(proposal, NOW), 2));
  const rangeFailure = runtime(fixture.entries, {
    validateRange: () => { throw new TaskRangeError("invalid-range", "private range detail"); },
    now: () => NOW,
  });
  await assert.rejects(
    rangeFailure.tools.get("efficiency_analyze")!.execute("call", {}, undefined, undefined, toolContext(fixture.entries)),
    expectCode("TASK_EFFICIENCY_ANALYSIS_NOT_READY"),
  );

  const isolated = await reviewFixture(t);
  const isolatedRuntime = runtime(isolated.entries, { now: () => NOW });
  await isolatedRuntime.tools.get("efficiency_propose_scope")!.execute(
    "call", isolated.input, undefined, undefined, toolContext(isolated.entries, ["确认范围"]),
  );
  isolated.entries.push({
    type: "message",
    id: "review-assistant",
    parentId: null,
    timestamp: NOW.toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "review-only tool body" }],
      provider: "review-provider",
      model: "review-model",
      usage: { input: 999999, output: 999999, totalTokens: 1999998, cost: { total: 99 } },
      stopReason: "stop",
    },
  } as unknown as SessionEntry);
  const report = JSON.parse((await isolatedRuntime.tools.get("efficiency_analyze")!.execute(
    "call", {}, undefined, undefined, toolContext(isolated.entries),
  )).content[0].text);
  assert.equal(report.usage.parent.events, 1);
  assert.equal(JSON.stringify(report).includes("review-provider"), false);
});

test("proposal append 失败时工具失败且绝不追加 confirmation", async (t) => {
  const fixture = await reviewFixture(t);
  const instance = runtime(fixture.entries, { now: () => NOW }, () => { throw new Error("proposal append failed"); });
  await assert.rejects(
    instance.tools.get("efficiency_propose_scope")!.execute(
      "call", fixture.input, undefined, undefined, toolContext(fixture.entries, ["确认范围"]),
    ),
    expectCode("TASK_EFFICIENCY_INTERNAL"),
  );
  assert.equal(customRecordCount(fixture.entries, "efficiency:confirmation"), 0);
});

test("取消与重选形成终态，不能在同一 review 恢复或替换 proposal", async (t) => {
  for (const action of ["取消复盘", "重新选择会话"] as const) {
    const fixture = await reviewFixture(t);
    const instance = runtime(fixture.entries, { now: () => NOW });
    await instance.tools.get("efficiency_propose_scope")!.execute(
      "call", fixture.input, undefined, undefined, toolContext(fixture.entries, [action]),
    );
    for (const input of [fixture.input, { ...fixture.input, summary: "Different proposal" }]) {
      await assert.rejects(
        instance.tools.get("efficiency_propose_scope")!.execute(
          "call", input, undefined, undefined, toolContext(fixture.entries, ["确认范围"]),
        ),
        expectCode("TASK_EFFICIENCY_REVIEW_STATE_INVALID"),
      );
    }
    assert.equal(customRecordCount(fixture.entries, "efficiency:proposal"), 1);
    assert.equal(customRecordCount(fixture.entries, "efficiency:termination"), 1);
    const termination = fixture.entries.find((entry: any) => entry.customType === "efficiency:termination") as any;
    assert.equal(termination.data.reason, action === "取消复盘" ? "cancelled" : "reselected");
  }
});

test("production reader 只信 review JSONL，不信内存 confirmation 或 report", async (t) => {
  const fixture = await reviewFixture(t);
  const proposal = createProposal(fixture.input, fixture.snapshot, fixture.range, NOW);
  const confirmation = confirmationForProposal(proposal, NOW);
  const openReviewPath = await writeReviewSession(t, fixture.marker, proposal);
  const memoryWithConfirmation = [
    custom(SOURCE_ENTRY_TYPE, fixture.marker),
    custom("efficiency:proposal", proposal, 1),
    custom("efficiency:confirmation", confirmation, 2),
  ];
  const openRuntime = runtime(memoryWithConfirmation, { now: () => NOW }, undefined, true);
  await assert.rejects(
    openRuntime.tools.get("efficiency_analyze")!.execute(
      "call", {}, undefined, undefined, productionToolContext(openReviewPath, "review-session", memoryWithConfirmation),
    ),
    expectCode("TASK_EFFICIENCY_CONFIRMATION_REQUIRED"),
  );

  const confirmedReviewPath = await writeReviewSession(t, fixture.marker, proposal, confirmation);
  const memoryWithReport = [
    custom(SOURCE_ENTRY_TYPE, fixture.marker),
    custom("efficiency:proposal", proposal, 1),
    custom("efficiency:confirmation", confirmation, 2),
    custom("efficiency:report", { fake: true }, 3),
  ];
  const appended: Array<{ customType: string; data: unknown }> = [];
  const confirmedRuntime = runtime(
    memoryWithReport,
    { now: () => NOW },
    (customType, data) => appended.push({ customType, data }),
    true,
  );
  const result = await confirmedRuntime.tools.get("efficiency_analyze")!.execute(
    "call", {}, undefined, undefined, productionToolContext(confirmedReviewPath, "review-session", memoryWithReport),
  );
  assert.equal(result.details.code, "TASK_EFFICIENCY_REPORT_READY");
  assert.deepEqual(appended.map((record) => record.customType), ["efficiency:report"]);
});

test("production reader 对缺失路径、session ID 不符和损坏 JSONL 均关闭", async (t) => {
  const fixture = await reviewFixture(t);
  const proposal = createProposal(fixture.input, fixture.snapshot, fixture.range, NOW);
  const reviewPath = await writeReviewSession(t, fixture.marker, proposal);
  const malformedPath = await writeReviewSession(t, fixture.marker, proposal);
  await writeFile(malformedPath, `${await readFile(malformedPath, "utf8")}{not-json}\n`);

  for (const [reviewPathValue, sessionId] of [
    [undefined, "review-session"],
    [reviewPath, "different-session"],
    [malformedPath, "review-session"],
  ] as const) {
    const instance = runtime([], { now: () => NOW }, undefined, true);
    await assert.rejects(
      instance.tools.get("efficiency_analyze")!.execute(
        "call", {}, undefined, undefined, productionToolContext(reviewPathValue, sessionId, []),
      ),
      expectCode("TASK_EFFICIENCY_REVIEW_STATE_INVALID"),
    );
  }
});
