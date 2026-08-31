# 设计系统 — Apple (Espana) Cathedral

> UI 语言的单一出处。token 落地在 `tauri/src/styles.css` 的 `:root`；改视觉前先读这里，别在组件里另起一套值。


> Cathedral of white space with whispered headlines. A vast pale hall where massive weight-700 type hangs in the air, tethered only by pastel product colors and a single blue thread.

本项目 UI 采用 Apple (Espana) 产品页语言的桌面化移植：

**Tokens（已落地到 src/styles.css :root）**
| 语义 | 值 | 用途 |
|------|-----|------|
| Primary Ink | #1d1d1f | 主文本、标题、强对比前景 |
| Mid Gray | #707070 | 次要文本、禁用占位 |
| Deep Gray | #474747 | 导航、工具按钮默认 |
| Hairline | #d6d6d6 | 唯一允许的边框（毛细线，分区不用实线） |
| Canvas | #f5f5f7 | 窗口画布灰带，与 Paper 交替形成节奏 |
| Paper | #ffffff | 卡片、白底、输入框 |
| Cool Wash | #e8e8ed | 悬浮洗色、hover 底 |
| Faded Surface | #fafafc | 抬升面板、导航毛玻璃 |
| Quiet Dot | #777779 | 分页点、微弱指示 |
| Electric Blue | #0071e3 | 唯一彩色 CTA 实心胶囊按钮 |
| Link Blue | #0066cc | 行内链接/高亮 |
| Ember | #b64400 | 新品/警示点缀 |
|  pastel finishes | Sky #c8d8e0 / Citrus #dddc8c / Starlight #f0e4d3 / Silver #e3e4e5 / Blush #e8d0d0 / Indigo #596680 / Midnight #2e3642 | 图标与插画的唯一彩色来源（来源应用色板） |

**排版**
- SF Pro Display 600/700 作标题（tracking -1.44px at 96px, -0.28px at 56px, +0.007em at 28px）
- SF Pro Text 400 作正文 13px（tracking -0.08px）、微文案 11-12px（tracking -0.04em~0.04em），`font-feature-settings: "numr" 1` 保持数位等宽
- 行高：Display 1.04–1.07 正本 1.45 形成层次，无需字号跳变

**间距与圆角**
- 基准 4px，密度 comfortable；卡片 16px（小密度）/ 28px（大卡），按钮 980px/999px 胶囊，输入 12px，窗口 20px
- Section 间距由 Canvas/Paper 交替完成，不用分割线或阴影

**组件映射（clipboard-tool 落地）**
- 全局窗：Canvas 半透明毛玻璃（blur 28px saturate 180%），Paper 卡片无边无影，靠画布交替区分
- 标题栏：44px 导航条，Faded Surface 毛玻璃（blur 20px）
- 搜索框：Paper 底 + Hairline，聚焦时 Electric Blue 0.14 4px 环
- 列表卡：Paper 底，默认 transparent 边，悬停 Faded Surface，选中 Electric Blue 6% + 1px 18% 内描边，深色模式对应 #2c2c2e/#3a3a3c
- 来源图标：按 appName 映射 pastel finish（notes/figma/safari 等），作唯一彩色载体，UI 其余保持单色
- 底部快捷条：Canvas 毛玻璃 + kbd 白底 Hairline 胶囊，Quiet Dot 标注
- 按钮：实心胶囊仅 Electric Blue 一处，其余 Ghost 胶囊（transparent + Hairline），Do: 单区最多一枚实心 CTA

**Do / DonDont 执行**
- Do: 交替 #ffffff/#f5f5f7 形成节奏、28px/16px 圆角、980px 胶囊、17px 级跟踪 -0.022em、numr 数字
- Dont: 无阴影（仅选中 1px 内描边）、无彩色点缀（除 Electric/Link Blue 与产品图）、标题不小于 12px 感知、不用实线分割、圆角不小于 8px、UI 面无渐变、字重不低于 400/600、链接无底盒、段落不居中
