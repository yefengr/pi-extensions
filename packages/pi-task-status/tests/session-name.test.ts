import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_NAME_OWNER_TYPE, shouldUpdateSessionName } from "../src/session-name.ts";

const info = { type: "session_info", id: "auto-1", name: "自动任务" };
const owner = {
  type: "custom",
  customType: SESSION_NAME_OWNER_TYPE,
  data: { version: 1, sessionInfoId: info.id, name: info.name },
};

test("首次无名可命名，已有无归属名称与手动清空不可覆盖", () => {
  assert.equal(shouldUpdateSessionName([], undefined, "新任务"), true);
  assert.equal(shouldUpdateSessionName([], "既有名称", "新任务"), false);
  assert.equal(shouldUpdateSessionName([info], info.name, "新任务"), false);
  assert.equal(shouldUpdateSessionName([{ type: "session_info", id: "clear", name: "" }], undefined, "新任务"), false);
});

test("按 ID 确认自动归属，同名去重，手动同名或清空也终止自动归属", () => {
  assert.equal(shouldUpdateSessionName([info, owner], info.name, "修正任务"), true);
  assert.equal(shouldUpdateSessionName([info, owner], info.name, info.name), false);
  for (const name of [info.name, "手动名称", ""]) {
    const manual = { type: "session_info", id: "manual", name };
    assert.equal(shouldUpdateSessionName([info, owner, manual], name || undefined, "新任务"), false);
  }
});

test("错误、损坏、顺序倒置的归属不授权，不回退到较早有效 marker", () => {
  const invalidValues = [
    null,
    [],
    {},
    { ...owner.data, version: 2 },
    { ...owner.data, sessionInfoId: "other" },
    { ...owner.data, sessionInfoId: "" },
    { ...owner.data, sessionInfoId: " auto-1 " },
    { ...owner.data, name: "其他名称" },
    { ...owner.data, name: "" },
    { ...owner.data, name: " 自动任务 " },
    { ...owner.data, name: "x".repeat(37) },
    { ...owner.data, extra: true },
  ];
  for (const data of invalidValues) {
    assert.equal(shouldUpdateSessionName([info, owner, { ...owner, data }], info.name, "新任务"), false);
  }
  assert.equal(shouldUpdateSessionName([owner, info], info.name, "新任务"), false);
  assert.equal(shouldUpdateSessionName([owner], undefined, "新任务"), false);
  assert.equal(shouldUpdateSessionName([info, owner], undefined, "新任务"), false);
});
