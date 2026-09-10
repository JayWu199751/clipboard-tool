// 60px 搜索头 + 36px 紧凑搜索井（源 UI §3 的目标形态）。
// 焦点环在井上（:focus-within），输入框自身 outline:none；井右侧 chip 由真实键位表生成。
// 井右外一枚主题钮：三态（亮 / 暗 / 跟随系统）一次点击走一格，图标与悬停提示都由 theme.ts 判出。
// 搜索是主进程模式（浏览态窗口不持焦点）：未激活时输入框 readOnly，点击井 = activateSearch。

import type { RefObject } from 'react';
import { Icon } from './icons';
import { NAV_KEYS, chipLabel } from './keyboard';
import { themeAriaLabel, themeIcon, themeTooltip, type ThemePreference } from './theme';

interface SearchHeaderProps {
  searchActive: boolean;
  query: string;
  inputRef: RefObject<HTMLInputElement | null>;
  theme: ThemePreference;
  systemIsDark: boolean;
  onQueryChange(value: string): void;
  onActivate(): void;
  onComposition(active: boolean): void;
  onCycleTheme(): void;
}

export function SearchHeader({
  searchActive,
  query,
  inputRef,
  theme,
  systemIsDark,
  onQueryChange,
  onActivate,
  onComposition,
  onCycleTheme,
}: SearchHeaderProps) {
  return (
    <header className="hud-search">
      <div className="hud-search__well" onClick={() => { if (!searchActive) onActivate(); }}>
        <Icon id="i-search" size={15} className="hud-search__icon" />
        <input
          id="search-input"
          className="hud-search__input"
          type="text"
          placeholder={searchActive ? '搜索文字、备注或来源应用…' : '搜索剪贴板…'}
          autoComplete="off"
          spellCheck={false}
          readOnly={!searchActive}
          aria-label="搜索剪贴板"
          value={query}
          ref={inputRef}
          onChange={(event) => onQueryChange(event.target.value)}
          onCompositionStart={() => onComposition(true)}
          onCompositionEnd={() => onComposition(false)}
        />
        {searchActive && query.length > 0 && (
          <button
            id="search-clear"
            type="button"
            className="hud-search__clear"
            aria-label="清除搜索"
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); onQueryChange(''); inputRef.current?.focus(); }}
          >
            <Icon id="i-x" size={12} />
          </button>
        )}
        {!searchActive && <kbd className="kbd hud-search__kbd" aria-hidden="true">{chipLabel(NAV_KEYS.search)}</kbd>}
      </div>
      {/* 提示框刻意自绘成一个真节点：原生 title 那套由系统绘制、不跟应用换肤
          （用户 2026-09-11 要求提示框适应亮暗）。同一份文案另进 aria-label——不悬停也读得到；
          tip 节点本身 aria-hidden，避免读屏把同一件事说两遍。 */}
      <div className="hud-search__theme-slot">
        <button
          id="search-theme"
          type="button"
          className="hud-search__theme"
          aria-label={themeAriaLabel(theme)}
          onClick={onCycleTheme}
        >
          <Icon id={themeIcon(theme)} size={16} />
        </button>
        <span className="hud-search__tip" aria-hidden="true">{themeTooltip(theme, systemIsDark)}</span>
      </div>
    </header>
  );
}
