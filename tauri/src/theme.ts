// 界面主题的判定侧：三态偏好（亮 / 暗 / 跟随系统）→ 生效皮肤、后继态、图标、文案、存档值。
// 效果住在 App.tsx（写 data-theme、落 localStorage、听系统换肤）与 index.html 的内联脚本
// （首帧前跑同一判定，防 FOUC）。内联脚本与本 module 是否同源由单测真跑一遍对表钉住，
// 不靠自觉；偏好为什么存渲染层而不是 settings.json，见 ADR-0012。

export type ThemePreference = 'light' | 'dark' | 'system';
export type EffectiveTheme = 'light' | 'dark';

/** 偏好存档键与默认值：写在用户机器上的既成事实，改名即丢档。 */
export const THEME_STORAGE_KEY = 'clipflow.theme';
export const DEFAULT_PREFERENCE: ThemePreference = 'system';

/** 合法偏好的全集（存档值与内联脚本都按它校验）。 */
export const THEME_PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'];

// 一次点击的去处：跟随系统 → 亮 → 暗 → 跟随系统。默认态排在循环末位，从它出发一次就到「亮」。
const NEXT: Record<ThemePreference, ThemePreference> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

// 三态一枚图标（icons.tsx 精灵里的 symbol id）：缺一枚就是空白按钮，由对表测兜住。
const ICONS: Record<ThemePreference, string> = {
  light: 'i-sun',
  dark: 'i-moon',
  system: 'i-display',
};

const LABELS: Record<ThemePreference, string> = {
  light: '亮',
  dark: '暗',
  system: '跟随系统',
};

const EFFECTIVE_LABELS: Record<EffectiveTheme, string> = { light: '亮', dark: '暗' };

/** 存档值归一：只认三个合法字面量，其余（含 null、手写坏值）一律回落默认。 */
export function normalizePreference(raw: unknown): ThemePreference {
  return (THEME_PREFERENCES as readonly unknown[]).includes(raw)
    ? (raw as ThemePreference)
    : DEFAULT_PREFERENCE;
}

/** 生效皮肤：只有跟随系统才看系统，手动两态盖过它。 */
export function resolveTheme(preference: ThemePreference, systemIsDark: boolean): EffectiveTheme {
  if (preference === 'system') return systemIsDark ? 'dark' : 'light';
  return preference;
}

export function nextPreference(preference: ThemePreference): ThemePreference {
  return NEXT[preference];
}

export function themeIcon(preference: ThemePreference): string {
  return ICONS[preference];
}

export function themeLabel(preference: ThemePreference): string {
  return LABELS[preference];
}

// 「当前：亮/暗」里那两枚字只服务 themeTooltip，不外抛：多一个出口就多一处能被写歪的地方
function effectiveLabel(theme: EffectiveTheme): string {
  return EFFECTIVE_LABELS[theme];
}

/** 悬停提示。跟随系统时补一句「当前」是亮是暗——手动两态没有歧义，不补。 */
export function themeTooltip(preference: ThemePreference, systemIsDark: boolean): string {
  const current = preference === 'system'
    ? `（当前：${effectiveLabel(resolveTheme(preference, systemIsDark))}）`
    : '';
  return `主题：${LABELS[preference]}${current} · 点击切到「${LABELS[nextPreference(preference)]}」`;
}

/** 无障碍名：提示框说的内容，不悬停也得拿到（hover-only 披露是禁止项）。 */
export function themeAriaLabel(preference: ThemePreference): string {
  return `界面主题：${LABELS[preference]}，点击切换`;
}

/** 存档值：默认偏好不落盘，新机器与恢复默认都留空档。 */
export function toStoredValue(preference: ThemePreference): string | null {
  return preference === DEFAULT_PREFERENCE ? null : preference;
}
