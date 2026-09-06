// 主进程 panel:key 转发的动作名（协议唯一出处：Rust panel_modes::Mode/NavAction 的 as_str）。
// up/down/enter/delete/pin/escape 是导航键直投；search-enter/exit 与
// note-edit-enter/exit 是输入态进出事件（B / 空格在 Rust 状态机内消化后转名投出）。
export type PanelKeyAction =
  | 'up'
  | 'down'
  | 'enter'
  | 'delete'
  | 'pin'
  | 'escape'
  | 'search-enter'
  | 'search-exit'
  | 'note-edit-enter'
  | 'note-edit-exit';

// 剪贴板历史条目类型定义
export interface SourceApp {
  exePath: string; // 来源 exe 完整路径，如 C:\Program Files\Google\Chrome\chrome.exe
  appName: string; // 无扩展名，如 chrome
  windowTitle: string; // 复制时前台窗口标题
  iconDataUrl: string | null; // 应用图标 dataUrl（base64 png），无则为 null
}

export interface ClipboardEntry {
  id: string;
  type: 'text' | 'image';
  text?: string;
  dataUrl?: string;
  createdAt: number;
  sourceApp?: SourceApp | null; // 来源应用，旧数据可能为 null
  pinned: boolean; // 是否置顶
  pinnedAt: number; // 置顶时间戳（毫秒），未置顶时为 0
  note: string; // 用户备注；无备注时为空字符串
}
