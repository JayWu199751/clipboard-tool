// useKeyboard()：源 UI「单一 capture 监听 + 中央注册表分发」在 Rust 拦截架构下的对应物
// （迁移方案已确认：键值零改动，注册表只搬位置）。渲染层唯一的按键入口是 panel:key 事件，
// 本 hook 把动作名分发到注册的处理函数；handlers 每次渲染换引用也不重订阅（ref 转发）。
// 例外：快捷键捕获覆盖层是渲染层自己的临时 capture keydown（仅捕获态挂载），
// 那是「录入新键值」的编辑器行为，不是面板导航键。

import { useEffect, useRef } from 'react';
import type { PanelKeyAction } from './types';

export type PanelKeyHandler = (noteEntryId: string | null) => void;

export function useKeyboard(handlers: Partial<Record<PanelKeyAction, PanelKeyHandler>>): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    window.clipboardAPI.onPanelKey((action, noteEntryId) => {
      ref.current[action]?.(noteEntryId ?? null);
    });
    // onPanelKey 内部按 channel 去重（generation 计数），空依赖只订阅一次
  }, []);
}
