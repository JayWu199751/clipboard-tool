// 60px 搜索头 + 36px 紧凑搜索井（源 UI §3 的目标形态）。
// 焦点环在井上（:focus-within），输入框自身 outline:none；井右侧 chip 由真实键位表生成。
// 搜索是主进程模式（浏览态窗口不持焦点）：未激活时输入框 readOnly，点击井 = activateSearch。

import type { RefObject } from 'react';
import { Icon } from './icons';
import { NAV_KEYS, chipLabel } from './keyboard';
import { themeControl } from './panelView';
import type { ThemePreference } from './types';

interface SearchHeaderProps {
  searchActive: boolean;
  query: string;
  inputRef: RefObject<HTMLInputElement | null>;
  themePreference: ThemePreference | null;
  themePending: boolean;
  onThemeToggle(): void;
  onQueryChange(value: string): void;
  onActivate(): void;
  onComposition(active: boolean): void;
}

export function SearchHeader({ searchActive, query, inputRef, themePreference, themePending, onThemeToggle, onQueryChange, onActivate, onComposition }: SearchHeaderProps) {
  const control = themePreference ? themeControl(themePreference) : null;
  const themeHint = control
    ? `主题：${control.label}，点击切换为${themeControl(control.next).label}`
    : '正在读取主题偏好';
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
        <button
          id="theme-toggle"
          type="button"
          className="hud-search__theme"
          title={themeHint}
          aria-label={themeHint}
          disabled={!control || themePending}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); onThemeToggle(); }}
        >
          <Icon id={control?.icon ?? 'i-monitor'} size={15} />
        </button>
        {!searchActive && <kbd className="kbd hud-search__kbd" aria-hidden="true">{chipLabel(NAV_KEYS.search)}</kbd>}
      </div>
    </header>
  );
}
