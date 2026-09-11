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
| `--window-ring` | #757575 | #757575 | 应用边框描边（返修 4/5 追加，非源 UI 值）：亮暗同值中灰实线，对齐系统窗口边框，两主题必须肉眼可辨 |
| `--shadow-card/toast/inset` | 黑重深影 | 着色低扩散 | 层级（**无窗口级阴影 token**：原生 shadow 关闭，描边与圆角由 CSS 承担） |

**主题**：三态偏好（亮色 / 暗色 / 跟随系统，默认跟随），入口是**托盘右键菜单的「主题」子菜单，面板内零开关**。偏好住 `settings.json` 的 `theme` 键，落地经 WebView2 的 `put_PreferredColorScheme` 改**网页自己的** `prefers-color-scheme`，所以渲染层不持有主题状态，换肤机制与「纯跟随系统」时期逐字相同：index.html 内联脚本按媒体查询在首帧前定 `html[data-theme]`（防 FOUC），App 的 `matchMedia` 监听实时同步，另在每次呼出时重刷一次作保险（运行时那一下是否触发 change 事件，官方未承诺）。理由与被否决方案见 [ADR-0012](adr/0012-theme-preference-in-main-process.md)。

托盘图标仍读**系统**主题而非面板皮肤（它该配任务栏）；面板手动设成亮色、系统是暗任务栏时，托盘保持白图。这条是刻意的不同源。

**排版**：Inter（人的内容）+ JetBrains Mono（机器数据：meta、chip、文件名、计数）。正文 13/1.55 三行 clamp；meta 10.5 mono；页脚 10.5 mono。界面全中文（时间词、toast、aria-label、键名「空格」；Ctrl/Alt/⇧ 保留拉丁）。

**布局与密度**：窗口尺寸随屏自适应——高 = 屏幕高的 7/8、宽 = 高的一半（DIP 空间计算，任何 DPI 同比例；`resizable:false` 只管用户拖拽，`show_at_cursor` 每次呼出可编程重设）；窄窗下页脚逐级收紧（400/340px 两档媒体查询），不裁组；行轨 60px 搜索头 / 1fr 列表 / 30px 页脚（行轨固定、列表吃掉剩余高度）；网格轨道 `minmax(0,1fr)` + 卡片 `min-width:0` 防长文本撑破窗口（迁移坑②）。圆角 28px（`--radius-window`，原 14、用户 2026-09-08 加倍；穿透判定读 `.desktop` 的 computed 值，自动跟上）；边框描边用真 2px 实线 `--window-ring`（中灰 #757575，亮暗同值；1px 弧是无抗锯齿翼的细阶梯、观感比实心直列窄——混叠错觉，圆角 14 下曾拍板回 1px，圆角加倍到 28 后返修 9 复看改判 2px；「border-width 归一到设备像素」是死路——Chromium 把 border-width 截断成整数 CSS px，测量复验见原型分支 prototype/ring-corner-mask；阴影矩形逐边取整不可控所以不用 inset shadow），`.desktop` 一律留 1 CSS px 内边距（不按缩放档位分治——真机 175% 实证设备像素级「恰好」会被边框取整方向吃掉右缘描边）——描边永不贴窗口物理边缘。

**组件映射**
- 搜索头：60px 头内一枚 36px 紧凑井（`--bg-input` + hairline + inset 高光），焦点环在井上（accent 描边 + 3px 柔光），输入框自身 `outline:none`；井右侧 chip 显示真实搜索键（未激活时）。
- 卡片：自上而下 = **内容 → meta 行**（2026-09-11 用户要求把 meta 从内容上方挪到下方）。meta 行 = 来源 · 时间 ·（可选）图钉 ·（可选）内联备注，单行省略号（类型标识 2026-09-11 随用户要求删除：文字/图片由内容形态本身区分，`--type-text/--type-image` 两枚 token 与 `i-text/i-image` 两枚图标随之退役，卡片的 `data-type` 属性保留——文字卡让开复制胶囊的规则还在读它）；内容文字卡 3 行 clamp；图片卡 150px 真实缩略图（棋盘格底）+ mono 文件名（磁盘真名 `<id>.png`），两段间距仍 12px。卡片间距：meta 行一律 `margin-top: var(--space-2)`，内容块自己不留底边距。hover/选中浮现「复制」胶囊（仍住右上角）——文字卡在这两态给 `.card__body` 让出 `padding-right: 68px`：正文现在从卡片顶边起排，不让位时实测长文本首行右缘 383px 会伸进胶囊 333px 起的区域，让位后收到 318px 且三行 clamp 的行数不变（改版前上面垫着 meta 行，胶囊压的是 meta、压不到正文）。
- 备注编辑：meta 行内联输入框（Enter 保存 / Esc 取消 / 失焦保存），**与 meta 行等高**：输入框 `height: 16px`、字号 10.5 与 meta 文本同号、行高显式 14px（= 16 − 上下各 1px 边框，不写会继承 meta 行的 16px 把字裁掉），meta 行则显式 `line-height: 16px` 撑住这个高度契约——两边同高，按下 B 才是零位移。原为 22px / 11.5px，比 15.2px 的自然行盒高出 6.8px，一进编辑态就把卡片撑高（89.5 → 96.28）、下方每条跟着跳 6.8px（2026-09-11 用户报「按下 B 复制项大小会改变」）。代价是每张卡比自然行盒恒定高 0.8px。判定在 `note-input-ring` 的编辑态几何用例（按 B 前后卡片高度/顶边/列表 scrollHeight 逐条相等）。焦点环与搜索井**同一口径**——只有输入框自己那一圈（1px `--border-selected` + 3px `--ring-soft`，全局 `:focus-visible` 的 outline 在 `.note-input` 上抑制）；编辑态那一条规则另把 meta 的单行裁切换成 `overflow: clip` + `overflow-clip-margin: 4px`，`hidden` 会把环的上下两边拦腰裁掉、只剩左右两截「括号」伸出输入框（2026-09-08 返修：用户报「蓝色边框超出界面」）。判定在 `note-input-ring` 两例。改版前这里还有一条 `padding-right: 76px` 给右上角胶囊让位，meta 行搬到下方后胶囊在最上一行、输入框在最下一行，两者永不相交，该让位已删（留着只是白丢一截输入宽度）。
- 页脚：左「N 条」，右 chip 组（选择 / 复制 / 置顶 / 备注 / 删除 / 隐藏，一组一枚 chip，↑↓ 并排同枚；组距 8px、组内 4px——真机字体比 headless 宽，密度按真机留余量）——**全部由 `keyboard.ts` 注册表生成**，禁止写死键名；搜索键住搜索井，呼出键归托盘与覆盖层，418px 窗口放得下且不压扁（`flex: none` 护栏）。
- toast：底部居中胶囊栈，成功绿勾 / 删除红叉 + 「撤销」动作（6s）；`aria-live`。
- 列表滚动条：自绘 4px 细条（`--scroll-thumb`），住在右侧 16px 留白内（right 5px），滚动后约 1s 自动隐藏；原生条在 `.cards` 上隐藏——真机经典滚动条占布局宽度，会把卡片右缘到边框垫出「留白 + 条宽」的不对称。
- 快捷键捕获覆盖层：原应用功能保留，HUD 皮肤（token 面 + 胶囊按钮）。

**动效与减少动态**：卡片状态过渡 100ms（`--dur-fast`）；复制闪光 500ms 绿→选中色收口；toast 240ms 进 / 160ms 出；`prefers-reduced-motion` 全关。源 UI 的 `window-in` 入场动画不迁移——真实应用显隐由原生窗口承担，scale 变换还会污染描边与滚动几何的测量。

**无障碍**：`role=listbox/option` + `aria-selected`、`aria-live` toast、`:focus-visible` 环、对比度 ≥4.5:1 双主题复算过。

**Do / Don't**
- Do：一切颜色/尺寸/动效走 token；mono=机器数据、sans=人的内容；选中=accent tint+描边；破坏性操作必须可撤销。
- Don't：组件内写死色值；实心大色块；emoji 图标（空态用 SVG）；渐变装饰背景；卡片堆叠网页风；侧栏/多面板工作台形态回潮；页脚或提示里手写键名。
