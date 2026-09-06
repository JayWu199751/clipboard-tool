# 任务：将 ClipFlow HUD 界面迁移到我的 Tauri 2 + React 19 剪贴板应用

## 角色
你是一名资深 Desktop UI 工程师，精通 React 19（函数组件 + Hooks + TypeScript strict）、Tauri 2 与 Vite 构建链。

## 目标
把一套已验证的「ClipFlow HUD」纯 HTML/CSS/JS 界面，迁移为我现有 Tauri 2 + React 19 + TypeScript 剪贴板应用的渲染层 UI。
**只迁移 UI 与交互层；我应用现有的数据层（剪贴板捕获、存储、Rust commands/invoke、全局快捷键注册）必须保留并对接，不得重写。**

## 输入材料（规格事实源，先完整阅读）
源 UI 位于 `clipboard-app/` 目录：
- `css/style.css` —— 设计系统全部 CSS 变量（`:root` 暗色 + `html[data-theme="light"]` 亮色覆盖块）、HUD 布局与全部组件样式。**所有颜色/尺寸/动效必须走 token，禁止组件内写死色值**
- `index.html` —— DOM 结构、SVG 图标精灵（outline 系、24-grid、stroke 1.75）、head 内主题预载脚本
- `js/clipboard.js` —— 数据层 mock。**只参考其 API 契约**（见下方 TS 接口），把我应用的真实数据源适配成同一契约，组件只依赖契约不碰 invoke
- `js/keyboard.js` —— 中央快捷键注册表（keyId 归一化、combo() 平台化显示、capture 阶段单一监听）。迁移为 React hook `useKeyboard()`，注册表逻辑原样保留并补类型
- `js/app.js` —— 视图状态机与全部交互行为（选中跟随、复制、备注内联编辑、删除+撤销、搜索防抖、关闭/重开），逐条对照实现
- `DESIGN.md` —— 设计系统文档（视觉方向、token 表、组件规格、键盘模型）。注意其 §8 是 Electron 建议，**桌面壳部分以本提示词「目标形态 · Tauri 2 壳层」一节为准**
- `REVIEW.md` —— UI Review 报告（含验收清单与已知坑）

> 设计说明：本 UI 的设计决策由 ui-ux-pro-max 设计智能库推导并已**全部固化**到上述文件中。迁移过程**以文件为唯一事实源，不要重新查询设计库或"再设计一遍"**。仅当你的环境装有 ui-ux-pro-max 技能时，可在最终验收阶段调用它、按其 Pre-Delivery Checklist 复查迁移结果；未安装则按 `REVIEW.md` 清单逐项人工核对，两者结论应一致。

## 数据契约（TypeScript）
```ts
type ClipItem =
  | { id: string; type: 'text';  content: string; source: string; ts: number }
  | { id: string; type: 'image'; content: string; src: string; width: number; height: number; source: string; ts: number }; // src = asset:/blob: URL

interface ClipStore {
  query(opts: { search?: string }): ClipItem[];          // 已按 ts 倒序 + 子串过滤(content+source)
  copy(item: ClipItem): Promise<boolean>;                 // text→writeText；image→writeImage(PNG base64)
  remove(id: string): { item: ClipItem; index: number } | null;
  restore(item: ClipItem, index: number): void;           // 撤销删除
  getNote(id: string): string;  setNote(id: string, text: string): void;
  total(): number;
}
```
删除/备注的持久化接到我应用现有存储层（Rust command 或插件 store），键语义保持 `deleted ids` 与 `notes by id`。

## 目标形态（必须精确还原）
1. **窗口（Tauri 2）**：`tauri.conf.json` → `app.windows[0]`：`width:400, height:800, resizable:false, minWidth=400, maxWidth=400, minHeight=800, maxHeight=800, decorations:false, alwaysOnTop:true, skipTaskbar:true, transparent:true, shadow:true`；渲染层根节点保留 14px 圆角 + hairline（透明窗圆角靠 CSS）。失焦即隐藏：`getCurrentWindow().onBlur(() => hide())`（开发期可关）；重开由全局快捷键接管，删除源 UI 里的 closed-hint 演示件
2. **布局**：60px 搜索头（36px 紧凑搜索井，焦点环在井上：accent 描边 + 3px 柔光，输入框自身 `outline:none`）→ 卡片列表 → 30px 快捷键页脚
3. **卡片**（text / image 两类）：
   - meta 行 = 仅图标的类型 chip（文字蓝/图片青，着色 token）· 来源 · 时间 ·（可选）内联备注，单行省略号
   - 文字卡正文 3 行 clamp；图片卡 150px 缩略图（真实图片用 `<img>`，棋盘格底保留）+ mono 文件名
   - hover/选中浮现「复制」胶囊；点击卡片 = 选中 + 复制（唯一主动作）
   - 选中态 = accent tint + accent 描边（禁止实心大色块）
4. **交互与快捷键（键位一律以我原应用现有绑定为准，ClipFlow 只定义行为）**：
   - **先枚举我原应用的现有键位表**（渲染层 hotkey 注册代码 + Rust 侧 globalShortcut 清单），全部原样保留，不得改键、不得删键、不得新增与源 UI 冲突的组合
   - 把下表行为映射到我原应用的对应按键上；下表「行为」列是必须实现的语义，「参考键」列仅为 ClipFlow 原方案，**若与我原应用键位不同，以我原应用为准**；若某行为在我原应用无对应按键，则该行为保留鼠标路径（或列出缺口问我，不要擅自加键）

   | 行为（必须实现） | ClipFlow 参考键 |
   |---|---|
   | 移动选中：搜索框输入时同样生效；选中项 scrollIntoView；循环钳位不绕回 | ↑↓ / Home / End |
   | 复制选中：备注编辑器内=保存备注 | Enter |
   | 选中卡片 meta 行内联备注输入框：Enter 保存/Esc 取消/失焦保存；编辑时 meta 预留 padding-right 避让复制胶囊 | B |
   | 删除选中：撤销 toast 6s；删除持久化 | Del / Backspace |
   | 聚焦搜索：输入中/按钮聚焦时不触发 | 空格 |
   | 聚焦搜索并全选 | Ctrl+F |
   | 取消备注编辑 → 否则 `getCurrentWindow().hide()` | Esc |
   | 全局唤起/隐藏（沿用我原应用已注册的全局快捷键，勿改） | Ctrl+Shift+V |

   - **页脚 chip 与一切按键提示必须由真实键位表在启动时生成**（照搬源 UI 的 `data-kbd` + `combo()` 机制）——迁移后它们自动显示我原应用的键位，保证「提示 = 行为」永不漂移
   - 与键位无关的行为规则照搬：启动焦点在列表（不在搜索框）；破坏性操作必须可撤销；遮罩层打开时屏蔽底层按键；输入框内不触发全局键
5. **主题**：纯跟随系统 —— 启动读 `getCurrentWindow().theme()` + 监听 `onThemeChanged`，写入 `document.documentElement.dataset.theme`；同时保留源 UI 的 `<head>` 内联脚本按 `prefers-color-scheme` 预载防 FOUC；两套 token 块原样搬运
6. **语言**：界面全中文（含时间词 刚刚/N 分钟前/昨天、toast、aria-label、键名「空格」；Ctrl/Alt/⇧ 保留拉丁）
7. **反馈**：复制成功 = 卡片绿色闪光 500ms + 底部胶囊 toast；删除 = 红色图标 toast + 「撤销」按钮

## 组件拆分（React 19 + TS）
`App.tsx`（视图状态机：items/selected/search/editingId，useReducer 或轻量 store，跟随我项目现状）
· `SearchHeader.tsx` · `ClipCard.tsx`（text/image 两态 + 内联备注）· `ToastStack.tsx`（含 action 按钮）· `icons.tsx`（SVG sprite 或 `<use>` 封装）
`useKeyboard(map)`：单一 capture keydown + 类型化注册表 `{ keys: string[]; handler(e, id); desc; group }`，`combo()` 平台化显示照搬；**注册表的 keys 来自我原应用现有键位表**（把原应用的散乱监听收敛进该注册表时，只搬位置、不改键值）

## 硬性约束
- React 19 函数组件 + TypeScript strict（`tsc --noEmit` 零错误）；**禁止**引入 Tailwind / Bootstrap / UI 组件库 / 图标 npm 包（图标用源文件内联 SVG）
- 样式：`style.css` token 块提为 `theme.css` 全局引入；组件样式拆为 CSS Modules 或普通 class（跟随我项目现状），**选择器语义与数值不得改动**
- 无障碍语义照搬：`role=listbox/option` + `aria-selected`、`aria-live` toast、`:focus-visible` 环、`prefers-reduced-motion`
- Tauri 权限：`capabilities/default.json` 按需补 `global-shortcut:allow-register`、`clipboard-manager:allow-write-text|write-image`、`core:window:allow-hide|show|set-focus`
- 已知坑必须规避：①全局 `[hidden]{display:none!important}`；②窗口网格 `minmax(0,1fr)` + 卡片 `min-width:0`（防长文本撑破固定窗口）；③常量/键名声明在使用它的初始化语句之前；④透明窗在 Windows 上的圆角/阴影以 CSS 为准，勿开原生 shadow 双阴影

## 执行步骤
1. 先勘察我的项目：报告目录结构、Rust commands 清单、invoke 封装位置、窗口配置与 capabilities 现状，**并输出一份「原应用现有快捷键全表」**（渲染层 + Rust 全局键），与我确认映射方案后再动手
2. 迁移 token 与全局样式 → 建立组件骨架 → `useKeyboard()` 与状态机逐条对照 `app.js` 行为、按键全部落在原应用键位上
3. 用 adapter 把真实数据接到 ClipStore 契约；删除/备注持久化落到我的存储层
4. Tauri 壳层：窗口参数、onBlur→hide、globalShortcut、theme 同步、capabilities
5. 自测验收（见下），输出结果后再收尾

## 验收标准（逐项验证并回报）
- [ ] 窗口恒为 400×800（DPI 缩放/多显示器不变），无边框、失焦即隐藏、用我原应用的全局键可唤起
- [ ] 我原应用的全部既有快捷键迁移后仍真实生效、无一改键/删键/新增冲突键；行为表中 8 项语义全部可用（按键以原应用为准）；页脚 chip 由真实键位表生成且与实际行为一致；启动焦点在列表
- [ ] 复制文字→系统剪贴板可读回文本；复制图片→剪贴板含 PNG 位图
- [ ] Del 删除 + 撤销恢复 + 重启后删除仍生效；搜索框内输入不触发任何全局键
- [ ] 备注：B 内联编辑、meta 行时间后单行省略、空则不占位、重启保留
- [ ] OS 切亮暗即时换肤无刷新；两套主题正文对比度 ≥4.5:1
- [ ] 长文本/长备注不撑破窗口（卡片右缘 ≤ 窗口右缘）
- [ ] 无新增 UI 类运行时依赖；`tsc --noEmit`、`npm run build`、`cargo check`（或 `tauri build`）通过；0 console 错误
- [ ] （可选）若环境装有 ui-ux-pro-max：按其 Pre-Delivery Checklist 复查并报告差异

## 禁止事项
- 不得改动/替换我现有的剪贴板捕获、Rust 存储、同步逻辑
- **不得修改我原应用的任何快捷键绑定（含全局唤起键）；缺键行为宁可只留鼠标路径也不擅自加键**
- 不得把 HUD 改回侧栏/多面板工作台形态
- 不得用 emoji 图标、渐变装饰背景、卡片堆叠的网页风
- 迁移存疑时以 `clipboard-app/` 源码实际行为为准，不要凭印象发挥，也不要依据设计技能库重新发明
