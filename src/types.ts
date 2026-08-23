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
}
