import { describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { SubagentsAgentsHandler } from "#src/ui/subagents-agents";
import { makeMenuUI } from "#test/helpers/ui-stubs";

function makeFixture() {
  const state = new Map<string, {
    enabled: boolean;
    source: "project" | "global" | "default";
    project?: boolean;
    global?: boolean;
  }>();
  const settings = {
    getState: (name: string) => state.get(name) ?? { enabled: true, source: "default" as const },
    getPath: (scope: "project" | "global") => `/settings/${scope}/subagents.json`,
    set: vi.fn((scope: "project" | "global", name: string, enabled: boolean | undefined) => {
      if (enabled === undefined) {
        state.delete(name);
      } else {
        state.set(name, { enabled, source: scope, [scope]: enabled });
      }
    }),
  };
  const registry = new AgentTypeRegistry(
    () => new Map([[
      "reviewer",
      {
        name: "reviewer",
        description: "Review code",
        toolNames: ["read", "grep"],
        systemPrompt: "Review code",
        promptMode: "replace" as const,
      },
    ]]),
    { reload: () => {}, getState: settings.getState },
  );
  const refresh = vi.fn(() => registry.reload());
  return { handler: new SubagentsAgentsHandler(registry, settings, refresh), settings, refresh };
}

describe("SubagentsAgentsHandler", () => {
  it("lists enabled and disabled agents and writes a project override", async () => {
    const { handler, settings, refresh } = makeFixture();
    const ui = makeMenuUI([
      "[启用] reviewer · 默认",
      "当前项目（继承）",
      "禁用",
      undefined,
      undefined,
    ]);

    await handler.handle({ ui });

    expect(ui.select.mock.calls[0][0]).toContain("2 启用 / 0 禁用");
    expect(settings.set).toHaveBeenCalledWith("project", "reviewer", false);
    expect(refresh).toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(
      "reviewer：已在当前项目设为禁用。当前项目禁用（当前项目）。",
      "info",
    );
    expect(ui.select.mock.calls[4][0]).toContain("1 启用 / 1 禁用");
  });

  it("lets the user choose global scope and restore that scope's inheritance", async () => {
    const { handler, settings } = makeFixture();
    const ui = makeMenuUI([
      "[启用] reviewer · 默认",
      "全局（继承）",
      "禁用",
      "全局（禁用）",
      "恢复继承",
      undefined,
      undefined,
    ]);

    await handler.handle({ ui });

    expect(settings.set).toHaveBeenNthCalledWith(1, "global", "reviewer", false);
    expect(settings.set).toHaveBeenNthCalledWith(2, "global", "reviewer", undefined);
  });
});
