import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SelectList, truncateToWidth } from "@earendil-works/pi-tui";
import type { WorktreeRecord } from "./worktree-types.ts";
import { formatLocalTime } from "./worktree-format.ts";

export async function selectWorktrees(
  ctx: ExtensionCommandContext,
  records: WorktreeRecord[],
): Promise<WorktreeRecord[] | undefined> {
  const selected = new Set<string>();
  const byPath = new Map(records.map((record) => [record.path, record]));
  const items = records.map((record) => ({
    value: record.path,
    label: `[ ] ${path.basename(record.path)}`,
    description: record.branch ?? "detached HEAD",
  }));

  return ctx.ui.custom<WorktreeRecord[] | undefined>((tui, theme, keybindings, done) => {
    const list = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    const toggle = (item: { value: string; label: string }) => {
      if (selected.has(item.value)) selected.delete(item.value);
      else selected.add(item.value);
      item.label = `[${selected.has(item.value) ? "x" : " "}] ${path.basename(item.value)}`;
      tui.requestRender();
    };
    list.onSelect = toggle;
    list.onCancel = () => done(undefined);

    return {
      render(width: number): string[] {
        const active = byPath.get(list.getSelectedItem()?.value ?? "");
        const times = active
          ? `创建：${formatLocalTime(active.createdAt, "未知")} | 最近提交：${formatLocalTime(active.lastCommitAt)}`
          : "";
        return [
          theme.fg("accent", truncateToWidth(`选择要移除的工作树 (${selected.size}/${records.length})`, width)),
          ...list.render(width),
          active ? theme.fg("muted", truncateToWidth(active.path, width)) : "",
          theme.fg("muted", truncateToWidth(times, width)),
          theme.fg("dim", truncateToWidth("空格勾选  Enter 确认选择  Esc 退出", width)),
        ];
      },
      invalidate() {
        list.invalidate();
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.space)) {
          const item = list.getSelectedItem();
          if (item) toggle(item);
          return;
        }
        if (keybindings.matches(data, "tui.select.confirm")) {
          if (selected.size) done(records.filter((record) => selected.has(record.path)));
          return;
        }
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}
