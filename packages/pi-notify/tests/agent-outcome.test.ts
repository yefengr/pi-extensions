import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentLifecycleNotification,
  classifyAgentEnd,
  updateAgentOutcome,
  type AgentOutcome,
} from "../src/agent-outcome.ts";

describe("agent outcome notifications", () => {
  it("classifies a normal stop as completed", () => {
    const outcome = classifyAgentEnd({
      messages: [{ role: "assistant", stopReason: "stop", content: "Done" }],
    });

    assert.deepEqual(outcome, { kind: "completed", stopReason: "stop" });
    assert.deepEqual(buildAgentLifecycleNotification(outcome, "notify-refactor"), {
      title: "Pi — 任务完成",
      message: "会话“notify-refactor”已正常完成。",
      level: "info",
    });
  });

  it("classifies a final provider error as abnormal termination", () => {
    const outcome = classifyAgentEnd({
      messages: [{
        role: "assistant",
        stopReason: "error",
        errorMessage: "Provider overloaded after retries",
        content: [],
      }],
    });

    assert.deepEqual(outcome, {
      kind: "error",
      stopReason: "error",
      errorMessage: "Provider overloaded after retries",
    });
    assert.deepEqual(buildAgentLifecycleNotification(outcome, undefined), {
      title: "Pi — 任务异常终止",
      message: "任务异常终止：Provider overloaded after retries",
      level: "error",
    });
  });

  it("classifies an aborted run separately", () => {
    const outcome = classifyAgentEnd({
      messages: [{ role: "assistant", stopReason: "aborted", content: [] }],
    });

    assert.equal(buildAgentLifecycleNotification(outcome, "manual-stop"), null);
  });

  it("treats an exhausted length stop as abnormal termination", () => {
    const outcome = classifyAgentEnd({
      messages: [{ role: "assistant", stopReason: "length", content: "partial" }],
    });

    assert.deepEqual(buildAgentLifecycleNotification(outcome, undefined), {
      title: "Pi — 任务异常终止",
      message: "任务异常终止：输出达到长度上限",
      level: "warning",
    });
  });

  it("treats a failed terminating tool batch as abnormal termination", () => {
    const outcome = classifyAgentEnd({
      messages: [
        { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall" }] },
        {
          role: "toolResult",
          isError: true,
          content: [{ type: "text", text: "用户拒绝执行命令" }],
        },
      ],
    });

    assert.deepEqual(buildAgentLifecycleNotification(outcome, undefined), {
      title: "Pi — 任务异常终止",
      message: "任务异常终止：用户拒绝执行命令",
      level: "error",
    });
  });

  it("treats a successful terminating tool batch as completed", () => {
    const outcome = classifyAgentEnd({
      messages: [
        { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall" }] },
        {
          role: "toolResult",
          isError: false,
          content: [{ type: "text", text: "操作已完成" }],
        },
      ],
    });

    assert.deepEqual(buildAgentLifecycleNotification(outcome, undefined), {
      title: "Pi — 任务完成",
      message: "任务已正常完成。",
      level: "info",
    });
  });

  it("uses the last low-level result after retry before settlement", () => {
    let outcome: AgentOutcome = { kind: "completed" };
    outcome = updateAgentOutcome(outcome, "agent_start");
    outcome = updateAgentOutcome(outcome, "agent_end", {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "overloaded" }],
    });
    assert.equal(outcome.kind, "error");

    outcome = updateAgentOutcome(outcome, "agent_start");
    outcome = updateAgentOutcome(outcome, "agent_end", {
      messages: [{ role: "assistant", stopReason: "stop", content: "retry succeeded" }],
    });
    outcome = updateAgentOutcome(outcome, "agent_settled");

    assert.deepEqual(outcome, { kind: "completed", stopReason: "stop" });
  });

  it("reports an unknown final state as abnormal termination", () => {
    const outcome = classifyAgentEnd({
      messages: [{ role: "assistant", stopReason: "unexpected", content: [] }],
    });

    assert.deepEqual(buildAgentLifecycleNotification(outcome, undefined), {
      title: "Pi — 任务异常终止",
      message: "任务异常终止：无法识别最终状态：unexpected",
      level: "error",
    });
  });

  it("reports a missing final assistant result as abnormal termination", () => {
    const outcome = classifyAgentEnd({ messages: [{ role: "user", content: "work" }] });

    assert.deepEqual(buildAgentLifecycleNotification(outcome, undefined), {
      title: "Pi — 任务异常终止",
      message: "任务异常终止：Agent 未返回最终结果",
      level: "error",
    });
  });

  it("uses recap as the completed notification body", () => {
    const outcome = { kind: "completed" as const, stopReason: "stop" };

    assert.deepEqual(
      buildAgentLifecycleNotification(outcome, "build", "构建和测试均已通过。"),
      {
        title: "Pi — build 已完成",
        message: "构建和测试均已通过。",
        level: "info",
      },
    );
  });
});
