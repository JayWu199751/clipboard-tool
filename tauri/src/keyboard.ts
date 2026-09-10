// 键盘注册表的判定侧（迁移自 clipboard-app/js/keyboard.js，注册表逻辑原样保留并补类型）。
//
// 与源 UI 的关键差异（迁移方案已确认）：面板导航键由 Rust 主进程全局拦截
// （panel_modes::NAV_SHORTCUTS，面板窗口浏览态不持焦点，渲染层收不到 keydown），
// 经 panel:key 事件把「动作名」转发进来。所以本 module 的注册表以动作名为键、
// 以 accel 为展示值：useKeyboard() 消费它做分发，页脚 chip 由同一份数据生成——
// 「提示 = 行为」不漂移。NAV_KEYS 是 Rust 表的镜像，一致性由
// scripts/panel-view-unit.mjs 解析 panel_modes.rs 对表钉住（跨语言防漂移）。

import type { PanelKeyAction } from './types';

const IS_MAC = /Mac|iPod|iPhone|iPad/.test(navigator.platform || '');
const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl';

// 面板导航键位表（渲染层镜像）。值 = Rust NAV_SHORTCUTS 的 accelerator 协议字符串。
// 注意 note / search 两个动作在 Rust 状态机内消化（转成 note-edit-enter /
// search-enter 事件），accel 仍在这里，因为页脚 chip 与帮助文案要展示真实按键。
export const NAV_KEYS = {
  up: 'Up',
  down: 'Down',
  enter: 'Enter',
  escape: 'Esc',
  delete: 'Delete',
  pin: 'Z',
  note: 'B',
  search: 'Space',
} as const;

// accel（Rust 协议串，如 Control+Shift+V / Up / Space）→ 源 UI 的 keyId 归一形
// （ctrl+shift+v / arrowup / ' '）。combo() 只认 keyId 形，展示统一走它。
const ACCEL_MODS: Record<string, string> = {
  control: 'ctrl',
  commandorcontrol: 'ctrl',
  cmd: 'cmd',
  shift: 'shift',
  alt: 'alt',
  super: 'meta',
  meta: 'meta',
};

const ACCEL_KEYS: Record<string, string> = {
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  esc: 'escape',
  escape: 'escape',
  space: ' ',
  del: 'delete',
  ins: 'insert',
  pgup: 'pageup',
  pgdn: 'pagedown',
};

export function accelToKeyId(accel: string): string {
  return accel
    .split('+')
    .map((raw) => {
      const part = raw.trim().toLowerCase();
      if (ACCEL_MODS[part]) return ACCEL_MODS[part];
      if (ACCEL_KEYS[part]) return ACCEL_KEYS[part];
      return part; // 字母 / 数字 / F1-F24 / enter / tab / home / end …已同形
    })
    .join('+');
}

/* ---------- Platform-aware display（源 keyboard.js KEY_NAMES / token / combo 照搬） ---------- */
const KEY_NAMES: Record<string, string> = {
  meta: '⌘', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
  enter: '⏎', escape: 'Esc', backspace: '⌫', delete: 'Del',
  home: 'Home', end: 'End', ' ': '空格', tab: 'Tab',
};

function token(p: string): string {
  if (p === 'ctrl') return MOD_LABEL;
  if (p === 'alt') return IS_MAC ? '⌥' : 'Alt';
  if (p === 'shift') return '⇧';
  if (KEY_NAMES[p]) return KEY_NAMES[p];
  return p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1);
}

/** "ctrl+shift+v" → "Ctrl ⇧ V"（macOS 上 "⌘ ⇧ V"）。源 UI 的 combo() 照搬。 */
export function combo(id: string): string {
  return id.split('+').map(token).join('\u2009');
}

/** accel → 展示文案：combo(accelToKeyId(accel))，页脚 chip 与覆盖层共用。 */
export function chipLabel(accel: string): string {
  return combo(accelToKeyId(accel));
}

/* ---------- 注册表（数据侧） ---------- */

/** 分发动作 = panel:key 协议里的动作名；'toggle' 只展示不分发（全局呼出在 Rust 侧执行）。 */
export type BindingAction = PanelKeyAction | 'toggle';

export interface KeyBinding {
  action: BindingAction;
  /** 展示用 accel（来自 NAV_KEYS 镜像或真实呼出键） */
  keys: string[];
  /** 中文行为描述 */
  desc: string;
  group: '导航' | '操作' | '搜索' | '面板';
}

/**
 * 注册表全量（帮助/审计口径）：导航与操作键全部来自 NAV_KEYS 镜像（= 原应用现有键位），
 * 呼出键条目供审计对表；页脚展示子集见 footerChips。
 */
export function buildBindings(toggleAccel: string): KeyBinding[] {
  return [
    { action: 'up', keys: [NAV_KEYS.up], desc: '选中上一张卡片', group: '导航' },
    { action: 'down', keys: [NAV_KEYS.down], desc: '选中下一张卡片', group: '导航' },
    { action: 'enter', keys: [NAV_KEYS.enter], desc: '复制并粘贴选中条目', group: '操作' },
    { action: 'pin', keys: [NAV_KEYS.pin], desc: '置顶 / 取消置顶', group: '操作' },
    { action: 'note-edit-enter', keys: [NAV_KEYS.note], desc: '添加 / 编辑备注', group: '操作' },
    { action: 'delete', keys: [NAV_KEYS.delete], desc: '删除选中条目（可撤销）', group: '操作' },
    { action: 'search-enter', keys: [NAV_KEYS.search], desc: '进入搜索', group: '搜索' },
    { action: 'escape', keys: [NAV_KEYS.escape], desc: '隐藏面板并归还焦点', group: '面板' },
    { action: 'toggle', keys: [toggleAccel], desc: '显示 / 隐藏面板', group: '面板' },
  ];
}

export interface FooterChip {
  /** 已平台化的 chip 文案（↑↓ 这类组合键并排两枚） */
  chips: string[];
  label: string;
}

/**
 * 页脚提示条：由注册表同一份键值生成，一组一枚 chip（↑↓ 并排写进同一枚 kbd，
 * 与源 UI 的 <kbd>↑↓</kbd> 同形——两枚 chip 会让这组多出一次 5px 间隙，节奏断裂）。
 * 只列面板可见时用得上的键：搜索键住在搜索井的 chip 里（空格），呼出键只在面板
 * 隐藏时有意义（那时页脚不可见；它的展示归托盘菜单与捕获覆盖层）。
 * 顺序即页脚顺序；一切按键提示都从这里出，禁止在组件里写死键名。
 */
export function footerChips(): FooterChip[] {
  return [
    { chips: [chipLabel(NAV_KEYS.up) + chipLabel(NAV_KEYS.down)], label: '选择' },
    { chips: [chipLabel(NAV_KEYS.enter)], label: '复制' },
    { chips: [chipLabel(NAV_KEYS.pin)], label: '置顶' },
    { chips: [chipLabel(NAV_KEYS.note)], label: '备注' },
    { chips: [chipLabel(NAV_KEYS.delete)], label: '删除' },
    { chips: [chipLabel(NAV_KEYS.escape)], label: '隐藏' },
  ];
}