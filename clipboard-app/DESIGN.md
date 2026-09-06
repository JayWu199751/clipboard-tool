# ClipFlow — Design System (HUD Edition)

> Simplified spec: **single card-style window, fixed 400 × 800, text + image clips, copy + delete actions, zh-CN interface.**
> Style basis: Minimalism/Swiss × Dark Native · Raycast/Maccy HUD. Type: Inter + JetBrains Mono.
> The previous full-workbench edition (sidebar/preview/palette/settings) was retired; its token architecture is kept intact.

---

## 1. Visual Direction

| Dimension | Decision |
|---|---|
| **Design Style** | Swiss-minimal HUD panel: chrome-less window (no traffic lights, no titlebar), search header + card column + hint footer. |
| **UI Personality** | Maccy/Raycast quick-paste: appears, you copy, it's gone. One action, zero modes. |
| **Brand Feeling** | Near-black neutral surfaces, one desaturated indigo accent reserved for selection/focus; cards lift off the canvas by lightness + hairline + micro-shadow, not decoration. |
| **Density** | 400px column, 10px card gaps, 3-line text clamp, 150px image thumbs — scannable at a glance. |
| **Iconography** | Single outline family (24-grid, stroke 1.75, inline SVG): search / text / image / copy / check / x. No emoji. |
| **Motion** | Window enter 240ms expo; card state transitions 100ms; copy flash 500ms green fade; toast 240ms in / 160ms out; `prefers-reduced-motion` respected. |

## 2. Color System — Dual Theme

All color lives in `:root` semantic tokens; `html[data-theme="light"]` is a single override block (zero component-level hex). **Theme always follows the OS appearance**: the inline `<head>` script resolves `prefers-color-scheme` before first paint (no FOUC), and a `matchMedia` change listener in `app.js` re-syncs live when the OS switches — there is no in-app theme pinning anymore (Electron seam: `nativeTheme.on("updated")` → same sync; `nativeTheme.themeSource = 'system'`).

| Token | Dark | Light | Usage |
|---|---|---|---|
| `--bg-app` | `#0B0B0E` | `#F0F0F3` | Window canvas / header / footer |
| `--bg-card` | `#141419` | `#FFFFFF` | Cards |
| `--bg-selected` | `rgba(123,119,224,.13)` | `rgba(93,89,202,.09)` | Selected card (tint, never solid) |
| `--border-subtle / strong / selected` | `.06 / .12 / indigo .45` white-alpha | `.08 / .16 / indigo .5` black-alpha | Hairlines, card outlines |
| `--text-primary / secondary / tertiary / disabled` | `#F2F2F5 / #A0A0AC / #7E7E8A / #55555F` | `#1A1A20 / #5A5A66 / #6E6E7A / #A2A2AC` | Contrast ≥4.5:1 verified per theme |
| `--accent / --accent-strong / --accent-text` | `#7B77E0 / #6763D6 / #A7A4F0` | `#5D59CA / #514DC0 / #5D59CA` | Selection, focus ring, copy chip |
| `--success` | `#57C08A` | `#2E9E68` | Copy flash + toast check |
| `--type-text / --type-image` | `#8FA6C9 / #57A8C0` | `#4A6A96 / #2E7D96` | Card type chips |
| Shadows | black-heavy, deep | tinted `rgba(30,30,60,…)`, lower spread | window / card / toast |

## 3. Typography

Inter (UI chrome, card text bodies) · JetBrains Mono (metadata, dimensions, kbd chips, type labels).
**Interface language: zh-CN** — all UI strings, toasts, time words (刚刚 / N 分钟前 / 昨天), key names (`空格`, `⌫`, `Del`) and aria labels are Chinese; modifier labels stay Latin (Ctrl/Alt/⇧, platform convention on Chinese Windows/macOS); mock clipboard content remains English (it is user data, not UI).
Search 14.5/500 · card body 13/1.55 (3-line clamp) · meta 10.5 mono · type label 9.5 mono uppercase · footer 10.5 mono · kbd 10.5 mono.
Discipline: mono = machine data, sans = human content.

## 4. Layout System

```
┌────────────────────────┐
│ [🔍 Search…        Space]│ 60px header · 36px well · drag region
├────────────────────────┤
│ ┌ [▤] · Slack · 2m ago · renew… [⧉] ┐│
│ │ Standup moved to 10:30…           ││  text card: note inline after time
│ └───────────────────────────────────┘│
│ ┌ [▣] · Figma · 14m ────────┐│
│ │   ▒▒ thumbnail 150px ▒▒   ││  image card: no dims chip
│ │   clipflow-onboarding@2x  ││
│ └───────────────────────────┘│
│  …scroll…                    │
├────────────────────────┤
│ 14 items   ↑↓ ⏎ B note Esc  │ 30px footer
└────────────────────────┘   fixed 400 × 800
```

Window **fixed 400 × 800** — never adapts to the viewport (no vw/vh clamps, no media queries; `resizable: false` in Electron). Radius 14, hairline + deep shadow. Rows: search 60 / list 1fr / footer 30.

## 5. Component Specs

- **Card (text)**: meta row = **icon-only type chip** (color-coded, no TEXT/IMAGE wording) + source + time + **inline note** (last segment, one-line ellipsis, absent when empty) → 3-line clamped body → hover/selected reveals "Copy" pill chip. Click = select + copy (the only action). No size/char-count text anywhere.
- **Card (image)**: meta row (same, note included) → 150px thumb (mock gradient + checkerboard; no dimensions chip) → mono filename. Copy writes a **real PNG** to the clipboard (canvas → `ClipboardItem`, graceful text fallback).
- **Note (备注)**: lives **in the meta row after the time**; persisted per item id at `clipflow.notes.v1`. Press `B` on the selected card → inline input replaces the note segment within the meta row (Enter saves, Esc cancels, blur saves; row reserves right padding so the editor never collides with the Copy chip); focus returns to the list after save.
- **Selection**: accent tint + accent hairline; keyboard focus follows selection (`scrollIntoView`), `role="listbox"/option` + `aria-selected`.
- **Copy feedback**: card flashes green (500ms) + bottom toast "Text/Image copied · source · time".
- **Search header**: 36px compact well (`--bg-input` + hairline) inside the 60px drag header — icon, input, clear button, `Space` chip. Focus ring lives on the **well** (accent hairline + 3px soft glow, fully contained by the window); the bare input suppresses its own `:focus-visible` outline. Live filter (120ms debounce) over content + source; ✕ clears.
- **Closed state**: Esc hides the window; a mono hint pill ("click anywhere or press Ctrl ⇧ V") centers on the desktop until reopened (Electron: `globalShortcut` summons instead).

## 6. Interaction & Keyboard Model

Central registry in `keyboard.js` — every advertised kbd chip is bound to a real `keydown` handler and platform-labeled at boot (`⌘` on macOS). Boot focus is the **list** (B/arrows/Enter work immediately); Space jumps to search.

| Key | Action |
|---|---|
| `↑ ↓` | Move selection (works while typing in search — Raycast behavior) |
| `Home / End` | First / last card |
| `Enter` | Copy selected (works from search field; inside note editor it saves the note) |
| `B` | Add / edit note on selected card |
| `Del` / `Backspace` | Delete selected clip (persisted by id; toast offers **撤销** for 6s) |
| `Space` | Focus search (type-to-search; never while typing, never on a focused button) |
| `Ctrl/⌘ F` | Focus search + select text (undocumented bonus) |
| `Esc` | Cancel note edit → else **close the HUD** (Electron: `win.hide()`) |
| `Ctrl/⌘ Shift V` | Show / hide ClipFlow (reopen while closed) |
| Click | Select + copy |

Removed with the simplification: sidebar/categories, favorites, delete+undo, preview panel, command palette, paste panel, settings, shortcut sheet, theme button (theme now follows OS/persisted pref). Esc no longer clears search (✕ button does).

## 7. Accessibility & Motion

`listbox/option` semantics, `aria-label` on icon buttons, `aria-live` toasts, visible `:focus-visible` rings, contrast ≥4.5:1 re-verified per theme, `prefers-reduced-motion` disables all animation.

## 8. Electron-readiness

- Window: `new BrowserWindow({ width: 400, height: 800, minWidth: 400, maxWidth: 400, minHeight: 800, maxHeight: 800, frame: false, transparent: true, alwaysOnTop: true, skipTaskBar: true, resizable: false })` + `hideOnBlur` → true Maccy-style HUD.
- Search header + footer already marked `-webkit-app-region: drag` (inputs/buttons `no-drag`).
- Seams unchanged: `ClipboardStore.copy()` → `electron.clipboard.writeText/writeImage`; global summon `Ctrl+Shift+V` → `globalShortcut` + `win.show()`; Esc → `win.hide()` (marked in `app.js`).
- Data: feed `items` from SQLite (`clips(id, type, content, source_app, ts)`), images from `userData/images`.
