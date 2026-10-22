import type { Component } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { EVENT_KEYS, loadConfig, saveConfig } from "../settings.js";
import type { NotifyConfig, NotifyEventKey } from "../types.js";
import { boxInnerWidth } from "../ui.js";

const EVENT_LABELS: Record<NotifyEventKey, string> = {
  agent_end: "Agent 运行结束",
  agent_settled: "Agent 已完成",
  session_shutdown: "会话结束",
};

type Section = "general" | "events";

export class NotifySettingsOverlay implements Component {
  private config: NotifyConfig = loadConfig();
  private section: Section = "general";
  private selectedIndex = 0;
  private saved = false;
  private theme: Theme | null = null;
  onClose?: () => void;
  requestRender?: () => void;
  onOpenModelSelector?: () => void;

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  invalidate(): void {}

  reload(): void {
    this.config = loadConfig();
    this.requestRender?.();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up") || data === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.selectedIndex = Math.min(this.maxItems - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "tab")) {
      this.section = this.section === "general" ? "events" : "general";
      this.selectedIndex = 0;
      return;
    }
    if (data === " ") {
      this.toggleCurrent();
      return;
    }
    if (data === "m" && this.section === "general" && this.selectedIndex === 1) {
      this.onOpenModelSelector?.();
      return;
    }
    if (matchesKey(data, "enter")) {
      this.save();
      return;
    }
    if (matchesKey(data, "escape")) this.onClose?.();
  }

  private get maxItems(): number {
    return this.section === "general" ? 2 : EVENT_KEYS.length;
  }

  private toggleCurrent(): void {
    if (this.section === "general") {
      if (this.selectedIndex === 0) this.config.enabled = !this.config.enabled;
      if (this.selectedIndex === 1) this.config.recap.enabled = !this.config.recap.enabled;
      return;
    }
    const key = EVENT_KEYS[this.selectedIndex];
    if (key) this.config.events[key].enabled = !this.config.events[key].enabled;
  }

  private save(): void {
    saveConfig(this.config);
    this.saved = true;
    setTimeout(() => this.onClose?.(), 500);
  }

  private fg(color: string, text: string): string {
    if (this.theme) return this.theme.fg(color as any, text);
    const colors: Record<string, string> = {
      accent: "\x1b[36m", success: "\x1b[32m", warning: "\x1b[33m", dim: "\x1b[2m", borderMuted: "\x1b[90m",
    };
    return `${colors[color] ?? ""}${text}\x1b[0m`;
  }

  private bold(text: string): string {
    return this.theme ? this.theme.bold(text) : `\x1b[1m${text}\x1b[0m`;
  }

  private frameLine(content: string, width: number): string {
    const truncated = truncateToWidth(content, width, "");
    return `${this.fg("borderMuted", "│")}${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}${this.fg("borderMuted", "│")}`;
  }

  private ruleLine(width: number): string {
    return this.fg("borderMuted", `├${"─".repeat(width)}┤`);
  }

  private borderLine(width: number, edge: "top" | "bottom"): string {
    const left = edge === "top" ? "┌" : "└";
    const right = edge === "top" ? "┐" : "┘";
    return this.fg("borderMuted", `${left}${"─".repeat(width)}${right}`);
  }

  render(width: number): string[] {
    const innerWidth = boxInnerWidth(width);
    const lines = [
      this.borderLine(innerWidth, "top"),
      this.frameLine(this.fg("accent", this.bold("通知设置")), innerWidth),
      this.frameLine(this.fg("dim", "配置本地终端通知和事件"), innerWidth),
      this.ruleLine(innerWidth),
      this.frameLine(`  ${this.section === "general" ? this.fg("accent", this.bold("[常规]")) : this.fg("dim", "常规")}  ${this.section === "events" ? this.fg("accent", this.bold("[事件]")) : this.fg("dim", "事件")}`, innerWidth),
      this.ruleLine(innerWidth),
    ];

    if (this.section === "general") this.renderGeneral(lines, innerWidth);
    else this.renderEvents(lines, innerWidth);

    if (this.saved) {
      lines.push(this.ruleLine(innerWidth));
      lines.push(this.frameLine(this.fg("success", "  设置已保存"), innerWidth));
    }
    lines.push(this.ruleLine(innerWidth));
    const hint = this.section === "general"
      ? "↑↓ 移动 · Space 切换 · M 选择模型 · Tab 切换 · Enter 保存 · Esc 返回"
      : "↑↓ 移动 · Space 切换 · Tab 切换 · Enter 保存 · Esc 返回";
    lines.push(this.frameLine(this.fg("dim", hint), innerWidth));
    lines.push(this.borderLine(innerWidth, "bottom"));
    return lines;
  }

  private renderGeneral(lines: string[], width: number): void {
    const rows = [
      { label: "启用通知", detail: this.config.enabled ? "已启用" : "已关闭", enabled: this.config.enabled },
      { label: "启用 recap", detail: this.config.recap.model ? `模型：${this.config.recap.model}` : "未选择模型", enabled: this.config.recap.enabled },
    ];
    rows.forEach((row, index) => {
      const selected = index === this.selectedIndex;
      lines.push(this.frameLine(`${selected ? this.fg("accent", "▸") : " "} ${row.enabled ? this.fg("success", "●") : this.fg("dim", "○")} ${selected ? this.bold(row.label) : this.fg("dim", row.label)}  ${this.fg("dim", row.detail)}`, width));
    });
    lines.push(this.frameLine(this.fg("dim", "  终端协议：根据当前终端自动选择"), width));
  }

  private renderEvents(lines: string[], width: number): void {
    EVENT_KEYS.forEach((key, index) => {
      const selected = index === this.selectedIndex;
      const enabled = this.config.events[key].enabled;
      lines.push(this.frameLine(`${selected ? this.fg("accent", "▸") : " "} ${enabled ? this.fg("success", "●") : this.fg("dim", "○")} ${selected ? this.bold(EVENT_LABELS[key]) : this.fg("dim", EVENT_LABELS[key])}`, width));
    });
  }
}
