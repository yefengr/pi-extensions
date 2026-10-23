import type { Component } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "../settings.js";
import { boxInnerWidth } from "../ui.js";

export interface RecapModelOption {
  provider: string;
  id: string;
  name?: string;
}

export class RecapModelSelectorOverlay implements Component {
  private selectedIndex = 0;
  private filter = "";
  private filterMode = false;
  private saved = false;
  private error: string | null = null;
  private theme: Theme | null = null;
  private filteredModels: RecapModelOption[];
  onClose?: () => void;
  requestRender?: () => void;

  constructor(private readonly models: RecapModelOption[]) {
    this.filteredModels = [...models];
    const currentModel = loadConfig().recap.model;
    const index = this.filteredModels.findIndex((model) => this.ref(model) === currentModel);
    if (index >= 0) this.selectedIndex = index;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.filterMode) {
      if (matchesKey(data, "enter")) {
        this.filterMode = false;
        return;
      }
      if (matchesKey(data, "escape")) {
        this.filter = "";
        this.filterMode = false;
        this.applyFilter();
        this.selectedIndex = 0;
        return;
      }
      if (data === "\x7f" || data === "\b") {
        this.filter = this.filter.slice(0, -1);
        this.applyFilter();
        this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
        return;
      }
      if (data.length === 1 && data >= " ") {
        this.filter += data;
        this.applyFilter();
        this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
      }
      return;
    }

    if (matchesKey(data, "up") || data === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.selectedIndex = Math.min(Math.max(0, this.filteredModels.length - 1), this.selectedIndex + 1);
      return;
    }
    if (data === "/") {
      this.filterMode = true;
      this.filter = "";
      return;
    }
    if (matchesKey(data, "enter")) {
      this.selectModel();
      return;
    }
    if (matchesKey(data, "escape")) this.onClose?.();
  }

  private applyFilter(): void {
    const query = this.filter.toLowerCase();
    this.filteredModels = query
      ? this.models.filter((model) => `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase().includes(query))
      : [...this.models];
  }

  private selectModel(): void {
    const model = this.filteredModels[this.selectedIndex];
    if (!model) {
      this.error = "当前没有可用模型";
      return;
    }
    const config = loadConfig();
    config.recap.model = this.ref(model);
    saveConfig(config);
    this.saved = true;
    this.error = null;
    setTimeout(() => this.onClose?.(), 500);
  }

  private ref(model: RecapModelOption): string {
    return `${model.provider}/${model.id}`;
  }

  private fg(color: string, text: string): string {
    if (this.theme) return this.theme.fg(color as any, text);
    const colors: Record<string, string> = {
      accent: "\x1b[36m", success: "\x1b[32m", warning: "\x1b[33m",
      error: "\x1b[31m", dim: "\x1b[2m", borderMuted: "\x1b[90m",
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

  private borderLine(width: number, edge: "top" | "bottom"): string {
    const left = edge === "top" ? "┌" : "└";
    const right = edge === "top" ? "┐" : "┘";
    return this.fg("borderMuted", `${left}${"─".repeat(width)}${right}`);
  }

  render(width: number): string[] {
    const innerWidth = boxInnerWidth(width);
    const lines = [
      this.borderLine(innerWidth, "top"),
      this.frameLine(this.fg("accent", this.bold("Recap 模型选择")), innerWidth),
      this.frameLine(this.fg("dim", "只显示当前 Pi 可用的模型"), innerWidth),
      this.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`),
    ];

    if (this.filterMode) {
      lines.push(this.frameLine(`  ${this.fg("accent", "筛选：")}${this.filter}${this.fg("accent", "█")}`, innerWidth));
    } else {
      lines.push(this.frameLine(this.fg("dim", `  ${this.models.length} 个可用模型 · 按 / 筛选`), innerWidth));
    }
    lines.push(this.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`));

    const rows = Math.max(5, (process.stdout.rows ?? 30) - 12);
    const start = Math.max(0, this.selectedIndex - Math.floor(rows / 2));
    const end = Math.min(this.filteredModels.length, start + rows);
    if (this.filteredModels.length === 0) {
      lines.push(this.frameLine(`  ${this.fg("warning", "没有可用模型")}`, innerWidth));
    } else {
      for (let i = start; i < end; i++) {
        const model = this.filteredModels[i];
        const selected = i === this.selectedIndex;
        const marker = selected ? this.fg("accent", "▸") : " ";
        const label = model.name ?? model.id;
        lines.push(this.frameLine(` ${marker} ${selected ? this.bold(label) : this.fg("dim", label)} ${this.fg("dim", `[${model.provider}]`)}`, innerWidth));
      }
    }

    if (this.error) {
      lines.push(this.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`));
      lines.push(this.frameLine(`  ${this.fg("error", this.error)}`, innerWidth));
    }
    if (this.saved) {
      lines.push(this.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`));
      lines.push(this.frameLine(`  ${this.fg("success", "模型已保存")}`, innerWidth));
    }
    lines.push(this.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`));
    lines.push(this.frameLine(this.fg("dim", "↑↓ 移动 · / 筛选 · Enter 选择 · Esc 返回"), innerWidth));
    lines.push(this.borderLine(innerWidth, "bottom"));
    return lines;
  }
}
