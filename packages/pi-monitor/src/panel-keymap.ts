import { getKeybindings, type Keybinding, type KeyId, type KeybindingsManager } from "@earendil-works/pi-tui";

/** 面板只接管导航和取消；停止、恢复等业务动作仍由本包固定快捷键触发。 */
export type PanelAction = "up" | "down" | "pageUp" | "pageDown" | "confirm" | "cancel";

const BINDINGS: Record<PanelAction, Keybinding> = {
  up: "tui.select.up",
  down: "tui.select.down",
  pageUp: "tui.select.pageUp",
  pageDown: "tui.select.pageDown",
  confirm: "tui.select.confirm",
  cancel: "tui.select.cancel",
};

const KEY_LABELS: Record<string, string> = {
  up: "↑", down: "↓", left: "←", right: "→",
  pageUp: "PgUp", pageDown: "PgDn", home: "Home", end: "End",
  return: "Enter", enter: "Enter", escape: "Esc", tab: "Tab",
  space: "Space", backspace: "⌫", delete: "Del", insert: "Ins",
};

/** 把 Pi 的按键标识转成底部提示里的短标签，未识别组合键按单词首字母大写。 */
export function formatKeyLabel(key: KeyId): string {
  const known = KEY_LABELS[key];
  if (known) return known;
  return key
    .split("+")
    .map((part) => (part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("+");
}

export interface PanelKeymap {
  matches(data: string, action: PanelAction): boolean;
  /** 实际生效的按键提示；没有绑定返回“未绑定”。 */
  hint(action: PanelAction): string;
}

/** 使用 Pi 注入的 keybindings；未注入时退回全局注册表，保证提示与实际按键一致。 */
export function createPanelKeymap(keybindings?: KeybindingsManager): PanelKeymap {
  const manager = keybindings ?? getKeybindings();
  return {
    matches: (data, action) => manager.matches(data, BINDINGS[action]),
    hint: (action) => {
      const keys = manager.getKeys(BINDINGS[action]);
      return keys.length ? keys.map((key) => formatKeyLabel(key)).join("/") : "未绑定";
    },
  };
}
