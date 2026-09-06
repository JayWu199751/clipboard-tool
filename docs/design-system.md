# 设计系统 — ClipFlow HUD

> UI 语言的单一出处。2026-09-08 起界面是 ClipFlow HUD（迁移自 `clipboard-app/`，其 DESIGN.md / REVIEW.md 是迁移的事实源存档）。
> token 落地在 `tauri/src/theme.css`（`:root` 暗色 + `html[data-theme="light"]` 覆盖块），组件样式在 `tauri/src/styles.css`——选择器语义与数值照搬源 UI，改视觉前先对照，别在组件里另起一套值。
> 旧版 Apple (Espana) Cathedral 语言随标题栏 / 详情面板 / 毛玻璃一并退役，其历史见 [changelog.md](changelog.md) 2026-09-05/06 条目。

**视觉方向**：Swiss-minimal HUD（Raycast / Maccy 快贴气质）——无 chrome 窗口、近黑中性面、一枚低饱和靛蓝 accent 只服务选中与焦点；卡片靠明度 + hairline + 微阴影抬起，不靠装饰。

**Tokens（theme.css，两套块）**
| 语义 | 暗 | 亮 | 用途 |
|------|-----|-----|------|
| `--bg-app` | #0B0B0E | #F0F0F3 | 窗口画布 / 搜索头 / 页脚 |
| `--bg-card` | #141419 | #FFFFFF | 卡片 |
| `--bg-selected` / `--border-selected` | 靛 13% / 白 45% alpha | 靛 9% / 黑 50% alpha | 选中态 = accent tint + accent 描边（禁止实心大色块） |
| `--text-primary/secondary/tertiary/disabled` | #F2F2F5 / #A0A0AC / #7E7E8A / #55555F | #1A1A20 / #5A5A66 / #6E6E7A / #A2A2AC | 正文对比度 ≥4.5:1 两套主题已复算（16.4 / 17.3 起） |
| `--accent / --accent-text / --accent-soft` | #7B77E0 / #A7A4F0 / 13% | #5D59CA / #5D59CA / 10% | 焦点环、复制胶囊、置顶图钉 |
| `--success` / `--error` | #57C08A / #E05A52 | #2E9E68 / #C9443C | 复制闪光与 toast 勾 / 删除 toast 叉 |
| `--type-text / --type-image` | #8FA6C9 / #57A8C0 | #4A6A96 / #2E7D96 | 卡片类型 chip（仅图标，着色走 token） |
| `--window-ring` | #757575 | #757575 | 应用边框描边（返修 4/5 追加，非源 UI 值）：亮暗同值中灰实线，对齐系统窗口边框，两主题必须肉眼可辨 |
| `--shadow-window/card/toast/inset` | 黑重深影 | 着色低扩散 | 层级 |

**主题**：纯跟随系统，无应用内开关。index.html 内联脚本按 `prefers-color-scheme` 首帧前定 `html[data-theme]`（防 FOUC），App 的 `matchMedia` 监听实时换肤。

**排版**：Inter（人的内容）+ JetBrains Mono（机器数据：meta、chip、文件名、计数）。正文 13/1.55 三行 clamp；meta 10.5 mono；类型标签 9.5 mono 大写；页脚 10.5 mono。界面全中文（时间词、toast、aria-label、键名「空格」；Ctrl/Alt/⇧ 保留拉丁）。

**布局与密度**：窗口恒 418×823（内容 = 源 UI 的 400×800 加描边留边，`resizable:false`，用户拍板不改配置）；行轨 60px 搜索头 / 1fr 列表 / 30px 页脚；网格轨道 `minmax(0,1fr)` + 卡片 `min-width:0` 防长文本撑破窗口（迁移坑②）。圆角 14px（`--radius-window`，穿透判定读 `.desktop` 的 computed 值）；边框描边用真 2px 实线 `--window-ring`（中灰 #757575，亮暗同值；1px 画弧是细阶梯、观感比直边窄，2px 让弧长出抗锯齿翼；阴影矩形逐边取整不可控所以不用 inset shadow），`.desktop` 一律留 1 CSS px 内边距（不按缩放档位分治——真机 175% 实证设备像素级「恰好」会被边框取整方向吃掉右缘描边）——描边永不贴窗口物理边缘。

**组件映射**
- 搜索头：60px 头内一枚 36px 紧凑井（`--bg-input` + hairline + inset 高光），焦点环在井上（accent 描边 + 3px 柔光），输入框自身 `outline:none`；井右侧 chip 显示真实搜索键（未激活时）。
- 卡片：meta 行 = 仅图标的类型 chip · 来源 · 时间 ·（可选）图钉 ·（可选）内联备注，单行省略号；文字卡 3 行 clamp；图片卡 150px 真实缩略图（棋盘格底）+ mono 文件名（磁盘真名 `<id>.png`）；hover/选中浮现「复制」胶囊。
- 备注编辑：meta 行内联输入框（Enter 保存 / Esc 取消 / 失焦保存），`.card:has(.note-input) .card__meta { padding-right: 76px }` 避让复制胶囊。
- 页脚：左「N 条」，右 chip 组（选择 / 复制 / 置顶 / 备注 / 删除 / 隐藏，一组一枚 chip，↑↓ 并排同枚；组距 8px、组内 4px——真机字体比 headless 宽，密度按真机留余量）——**全部由 `keyboard.ts` 注册表生成**，禁止写死键名；搜索键住搜索井，呼出键归托盘与覆盖层，418px 窗口放得下且不压扁（`flex: none` 护栏）。
- toast：底部居中胶囊栈，成功绿勾 / 删除红叉 + 「撤销」动作（6s）；`aria-live`。
- 列表滚动条：自绘 4px 细条（`--scroll-thumb`），住在右侧 16px 留白内（right 5px），滚动后约 1s 自动隐藏；原生条在 `.cards` 上隐藏——真机经典滚动条占布局宽度，会把卡片右缘到边框垫出「留白 + 条宽」的不对称。
- 快捷键捕获覆盖层：原应用功能保留，HUD 皮肤（token 面 + 胶囊按钮）。

**动效与减少动态**：卡片状态过渡 100ms（`--dur-fast`）；复制闪光 500ms 绿→选中色收口；toast 240ms 进 / 160ms 出；`prefers-reduced-motion` 全关。源 UI 的 `window-in` 入场动画不迁移——真实应用显隐由原生窗口承担，scale 变换还会污染描边与滚动几何的测量。

**无障碍**：`role=listbox/option` + `aria-selected`、`aria-live` toast、`:focus-visible` 环、对比度 ≥4.5:1 双主题复算过。

**Do / Don't**
- Do：一切颜色/尺寸/动效走 token；mono=机器数据、sans=人的内容；选中=accent tint+描边；破坏性操作必须可撤销。
- Don't：组件内写死色值；实心大色块；emoji 图标（空态用 SVG）；渐变装饰背景；卡片堆叠网页风；侧栏/多面板工作台形态回潮；页脚或提示里手写键名。