import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import extensionFactory from "../src/extension.ts";

const tools: ToolDefinition[] = [];
extensionFactory({
  registerTool: (tool: ToolDefinition) => tools.push(tool),
  on() {},
} as unknown as ExtensionAPI);
const tool = tools[0];
assert.ok(tool);
const minimal = { taskTransition: "continue", status: "in_progress", progressPercent: 40 };

test("real tool schema and SDK accept omitted names and phases on continue", () => {
  for (const input of [minimal, { ...minimal, taskName: "任务" }, { ...minimal, phase: "验证" }, { ...minimal, taskName: "任务", phase: "验证" }]) {
    assert.equal(Value.Check(tool.parameters, input), true);
    assert.deepEqual(validateToolArguments(tool, {
      type: "toolCall", id: "schema-test", name: tool.name, arguments: input,
    }), input);
  }
});

test("SDK treats null optional fields as omissions without mutating the call", () => {
  const input = { ...minimal, taskName: null, phase: null };
  assert.deepEqual(validateToolArguments(tool, {
    type: "toolCall", id: "schema-null", name: tool.name, arguments: input,
  }), minimal);
  assert.deepEqual(input, { ...minimal, taskName: null, phase: null });
});

test("real tool schema enumerates all coarse progress values", () => {
  for (let progressPercent = 0; progressPercent <= 100; progressPercent += 10) {
    const input = { ...minimal, status: progressPercent === 100 ? "completed" : "in_progress", progressPercent };
    assert.equal(Value.Check(tool.parameters, input), true);
  }
  for (const progressPercent of [-10, 5, 55, 99, 110, 10.5, "40", null]) {
    assert.equal(Value.Check(tool.parameters, { ...minimal, progressPercent }), false);
  }
});

test("real tool schema preserves required transition status and progress", () => {
  for (const field of ["taskTransition", "status", "progressPercent"] as const) {
    const input: Record<string, unknown> = { ...minimal };
    delete input[field];
    assert.equal(Value.Check(tool.parameters, input), false);
  }
  assert.equal(Value.Check(tool.parameters, { ...minimal, status: "unknown" }), false);
  assert.equal(Value.Check(tool.parameters, { ...minimal, taskId: "model-owned" }), false);
});

test("real tool schema rejects explicit empty or non-string optional fields", () => {
  for (const field of ["taskName", "phase"]) {
    for (const value of ["", null, 123, false]) {
      assert.equal(Value.Check(tool.parameters, { ...minimal, [field]: value }), false);
    }
  }
});

test("tool metadata contains no duplicate scheduling guidelines", () => {
  assert.equal(tool.promptGuidelines, undefined);
  assert.doesNotMatch(`${tool.description}\n${tool.promptSnippet}`, /10 minutes|waiting_for_user|里程碑|首次识别|完成前/);
});
