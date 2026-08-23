# ClipboardTool 项目上下文

> 本文档是工程的「共享词汇 + 决策档案」。项目本身见 [README.md](README.md)。

## 项目概述

Windows 剪贴板历史工具（Electron + React + Vite）。主进程轮询剪贴板（600ms），把文字/图片历史存入 `%APPDATA%\ClipboardTool\clipboard-history.json`；渲染进程只负责面板 UI 与键盘导航。全局快捷键 `Ctrl+Shift+V` 呼出不可激活（WS_EX_NOACTIVATE）的置顶浮层面板，不抢占输入框焦点。

## 领域词汇

| 术语 | 含义 |
| --- | --- |
| 历史条目（ClipboardEntry） | 一条剪贴板记录，`text` 或 `image` 类型；主进程内存中额外持有 `imagePath`，渲染层收到的是 `dataUrl` |
| 历史（history） | 主进程内存数组，顺序即面板显示顺序；最新使用在最前 |
| 置顶（pinned） | 条目上的布尔标记；置顶条目固定排在列表最前，重启后保留 |
| 置顶时间（pinnedAt） | 最近一次置顶的时间戳（毫秒）；未置顶为 0，多个置顶条目按它新→旧排序 |
| 置顶块 | 列表头部所有置顶条目形成的连续块；新复制内容永远插在它之后 |
| 普通块 | 置顶块之后的普通条目，按最近使用（复制/新建）新→旧排列 |
| 来源应用（SourceApp） | 复制时前台应用（exePath / appName / windowTitle / iconDataUrl），轮询 A 版方案 |
| 提权粘贴 | 以管理员权限运行 `elevated-helper.exe`，通过命名管道让 SendInput 粘贴进管理员程序 |

## 架构脉络

- `electron/main.js`：剪贴板轮询、去重、历史持久化、全局快捷键（呼出 + 面板导航 `↑/↓/Enter/Esc/Del/Z`）、自动粘贴、托盘、提权助手。
- `electron/preload.js`：`contextBridge` 暴露 `window.clipboardAPI`（getHistory / onUpdated / copy / remove / pin / clear / 快捷键 / 提权）。
- `src/App.tsx`：面板 UI、主题、键盘逻辑（主进程面板键经 `panel:key` 转发）、快捷更换覆盖层。
- 数据流向：主进程维护唯一真相，`broadcast()` 推 `clipboard:updated` 给渲染层；渲染层不直接改数组。

## 关键决策（设计树档案）

以下为 `/grill-with-docs` 访谈确认的置顶功能决策：

1. **排序语义**：置顶条目形成「置顶块」固定在最前；新复制内容插入置顶块之后、普通块最前。
2. **置顶块内部排序**：按置顶时间 `pinnedAt` 新→旧（最近置顶在最前），多次重排由刷新 `pinnedAt` 实现。
3. **复制置顶条目**（Enter / 双击）：保持置顶，刷新 `pinnedAt` 并移到置顶块最前，行为与复制普通条目一致。
4. **复制普通条目**：插入置顶块之后、普通块最前。
5. **删除/清空**：不豁免置顶条目 —— 置顶只是排序优先级，不是保护锁。
6. **历史上限裁剪**（`MAX_HISTORY = 200`）：置顶条目**豁免**，先裁普通块尾部；全部都是置顶时才裁最旧置顶。
7. **键盘快捷键**：面板显示期间 `Z` 置顶/取消置顶选中项（加入 `NAV_SHORTCUTS`，随面板显示/隐藏注册/注销）。
8. **视觉状态**：置顶图标与复制/删除同风格（15×15、stroke 2、round、currentColor）；置顶时图标实心填充，未置顶为描边。tooltip 随状态显示「置顶 / 取消置顶」。
9. **图标布局**：置顶按钮放在复制图标左侧；`.item-actions` 统一 `gap: 2px`，保证「置顶↔复制」与「复制↔删除」距离相等。
10. **持久化**：`pinned` / `pinnedAt` 随历史 JSON 持久化；旧数据加载时归一化（缺省为 `false` / `0`）。

## 变更日志

- 置顶功能：新增 `clipboard:pin` IPC、`Z` 面板键、`PinIcon`、置顶块排序/插入/裁剪豁免逻辑，README 与本文档同步。
