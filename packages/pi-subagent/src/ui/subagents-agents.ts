import type { AgentEnablementScope, AgentEnablementState } from "#src/config/agent-enablement";
import type { AgentTypeRegistry } from "#src/config/agent-types";
import { BUILTIN_TOOL_NAMES } from "#src/config/agent-types";
import type { AgentConfig } from "#src/types";

interface AgentSettings {
  getState(name: string): AgentEnablementState;
  getPath(scope: AgentEnablementScope): string;
  set(scope: AgentEnablementScope, name: string, enabled: boolean | undefined): void | Promise<void>;
}

export interface SubagentsAgentsUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

const SOURCE_LABELS = { project: "当前项目", global: "全局", default: "默认" } as const;
const BACK = "返回代理列表";
const ACTIONS = ["启用", "禁用", "恢复继承"];

function stateLabel(enabled: boolean): string {
  return enabled ? "启用" : "禁用";
}

function overrideLabel(enabled: boolean | undefined): string {
  return enabled === undefined ? "继承" : stateLabel(enabled);
}

/** Native dialogs keep keyboard navigation, filtering and terminal sizing in Pi. */
export class SubagentsAgentsHandler {
  constructor(
    private readonly registry: Pick<AgentTypeRegistry, "getAllTypes" | "resolveAgentConfig">,
    private readonly settings: AgentSettings,
    private readonly refresh: () => void,
  ) {}

  async handle({ ui }: { ui: SubagentsAgentsUI }): Promise<void> {
    while (true) {
      this.refresh();
      const entries = this.registry.getAllTypes().map((name) => {
        const state = this.settings.getState(name);
        return { name, label: `[${stateLabel(state.enabled)}] ${name} · ${SOURCE_LABELS[state.source]}` };
      });
      if (entries.length === 0) {
        ui.notify("没有可管理的子代理。", "info");
        return;
      }
      const enabled = entries.filter(({ name }) => this.settings.getState(name).enabled).length;
      const choice = await ui.select(
        `子代理（${enabled} 启用 / ${entries.length - enabled} 禁用）`,
        entries.map(({ label }) => label),
      );
      const entry = entries.find(({ label }) => label === choice);
      if (!entry) return;
      await this.manageAgent(entry.name, ui);
    }
  }

  private async manageAgent(name: string, ui: SubagentsAgentsUI): Promise<void> {
    while (true) {
      this.refresh();
      // 用户可能在菜单打开期间删除定义；不要把回退配置显示成原代理。
      if (!this.registry.getAllTypes().includes(name)) {
        ui.notify(`代理 ${name} 的定义已移除。`, "warning");
        return;
      }
      const state = this.settings.getState(name);
      const config = this.registry.resolveAgentConfig(name);
      const scopes = [
        { scope: "project" as const, label: `当前项目（${overrideLabel(state.project)}）` },
        { scope: "global" as const, label: `全局（${overrideLabel(state.global)}）` },
      ];
      const choice = await ui.select(this.details(config, state), [...scopes.map(({ label }) => label), BACK]);
      const selected = scopes.find(({ label }) => label === choice);
      if (!selected) return;
      await this.changeState(name, selected.scope, ui);
    }
  }

  private details(config: AgentConfig, state: AgentEnablementState): string {
    const tools = config.toolNames ?? BUILTIN_TOOL_NAMES;
    return [
      config.displayName ? `${config.displayName} (${config.name})` : config.name,
      config.description,
      `状态：${stateLabel(state.enabled)} · 来源：${SOURCE_LABELS[state.source]}`,
      `模型：${config.model ?? "继承父代理"} · 思考：${config.thinking ?? "继承父代理"}`,
      `工具：${tools.length ? tools.join(", ") : "无"}`,
      `定义：${config.filePath ?? "内置"}`,
      "选择启停设置的作用域：",
    ].join("\n");
  }

  private async changeState(name: string, scope: AgentEnablementScope, ui: SubagentsAgentsUI): Promise<void> {
    const choice = await ui.select(
      `${name} · ${SOURCE_LABELS[scope]}\n保存到：${this.settings.getPath(scope)}\n恢复继承：${scope === "project" ? "跟随全局设置" : "回到默认启用"}`,
      ACTIONS,
    );
    if (!choice || !ACTIONS.includes(choice)) return;
    const enabled = choice === "恢复继承" ? undefined : choice === "启用";
    try {
      await this.settings.set(scope, name, enabled);
    } catch (error) {
      ui.notify(`保存失败：${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
    this.refresh();
    const state = this.settings.getState(name);
    const overridden = scope === "global" && state.project !== undefined;
    ui.notify(
      `${name}：已在${SOURCE_LABELS[scope]}${choice === "恢复继承" ? "恢复继承" : `设为${choice}`}。` +
      `当前项目${stateLabel(state.enabled)}（${SOURCE_LABELS[state.source]}）。` +
      (overridden ? "全局设置被当前项目设置覆盖。" : ""),
      overridden ? "warning" : "info",
    );
  }
}
