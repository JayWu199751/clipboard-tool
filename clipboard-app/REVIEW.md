# ClipFlow — Desktop UI Review Report (HUD Edition)

Scope: simplified single-window spec — **fixed 400 × 800** card list (never adapts to viewport), text + image clips, copy-only.
Verified in Chromium (Playwright, trusted key events, DOM geometry + computed-style + **real clipboard read-back**, 0 console errors).

## 1. Visual

| Check | Verdict | Evidence |
|---|---|---|
| Desktop HUD feel (not a web page) | ✅ Pass | Chrome-less fixed 400×800 panel, hairline + deep shadow on fake desktop, no page scroll, mono metadata, kbd chips; reads as Maccy/Raycast quick-paste |
| Card style discipline | ✅ Pass | Cards lift by lightness + 1px hairline + micro-shadow only; selection = accent tint + accent hairline; no gradients-as-decoration, no Bootstrap/admin patterns |
| Theme (system-follow) | ✅ Pass | Single `html[data-theme="light"]` token block; light contrast re-verified (primary 15.9:1, tertiary 4.9:1); theme **always follows the OS** — resolved pre-paint (no FOUC) + live `matchMedia` re-sync verified by flipping the emulated OS scheme without reload; no in-app pinning remains |
| Typography | ✅ Pass | Inter for content, JetBrains Mono for machine data (meta/dims/kbd/filenames); 3-line clamp keeps cards uniform |
| Icons | ✅ Pass | One outline family, stroke 1.75, 7 glyphs total — matches the reduced feature surface |

## 2. UX

| Check | Verdict |
|---|---|
| Copy is the only action | ✅ Click card = select + copy; Copy chip on hover/selected; Enter copies (even from search field) |
| Keyboard-first | ✅ ↑↓/Home/End/Enter/Esc/B/Space/Ctrl+F/Ctrl+Shift+V all bound to real keydown events and verified with trusted key presses; boot focus on list so B/arrows work immediately; Space = type-to-search |
| Feedback | ✅ Green copy-flash on card (500ms) + toast "Text/Image copied · source · time"; note save/remove toast |
| Notes (备注) | ✅ Inline in meta row after the time; B opens inline editor (Enter saves / Esc cancels / blur saves), one-line ellipsis, hidden when empty, persisted at `clipflow.notes.v1` |
| Delete (Del/⌫) | ✅ Deletes selected clip with 6s **撤销** toast; deletion persisted by id (`clipflow.deleted.v1`, load-time filter — var-hoisting bug caught & fixed); guarded while typing / editing notes / HUD closed |
| Localization | ✅ Full zh-CN UI (placeholders, hints, toasts, time words, aria); key names localized (`空格`), modifiers kept Latin per platform convention |
| Close / reopen | ✅ Esc closes the HUD (edit-cancel takes priority first); click-on-desktop or Ctrl+Shift+V reopens fresh (search cleared, list focused) |
| Real clipboard | ✅ Text → `writeText` (read-back matches); Image → canvas-rendered **`image/png` written via `ClipboardItem`** (read-back shows `image/png`), graceful fallback to filename text |
| Search | ✅ 120ms debounce over content + source; ✕ button clears (Esc now closes the HUD); empty state with hint |
| Scope honesty | ✅ Removed: sidebar/categories, favorites, delete+undo, preview, palette, paste panel, settings, shortcut sheet, theme button — no orphan UI or dead shortcuts remain |

**Residual gaps (acceptable for HUD scope):** no type filter chips (text vs image) — trivial to add if needed; no paste-on-Enter simulation (browser sandbox); no window drag in browser (Electron drag regions already marked).

## 3. Code

| Check | Verdict |
|---|---|
| Size | ✅ ~1/3 of the workbench edition: 4 files, no dead CSS/JS for removed features |
| Token discipline | ✅ Zero raw hex in components; both themes = two token blocks |
| Module seams | ✅ `clipboard.js` (data+copy) / `keyboard.js` (registry) / `app.js` (view) — unchanged contracts, easier Electron migration |
| A11y | ✅ listbox/option + aria-selected, aria-live toasts, focus-visible, reduced-motion |

## 4. Electron 化建议 (HUD path — shorter than before)

1. **Window**: `BrowserWindow 400×800, frame:false, transparent:true, alwaysOnTop, skipTaskbar, resizable:false`; show at cursor/center; `blur → hide()` (Maccy behavior).
2. **Summon**: `globalShortcut.register('CommandOrControl+Shift+V')` → `win.show()` + `win.focus()`; Esc → `win.hide()` (seam already commented in `app.js`).
3. **Capture**: poll `clipboard.readText()/readImage()` @500ms + hash dedupe; images to `userData/images`, rows in SQLite (`type IN ('text','image')`); `hideOnBlur` + `backgroundThrottling:false`.
4. **Copy**: replace `ClipboardStore.copy()` body with `electron.clipboard.writeText/writeImage` — canvas/PNG path already proves the contract in-browser.
5. **Security**: `contextIsolation:true`, preload `contextBridge` exposing `api.copyClip/onClip`; CSP meta.
6. Effort: **3–5 days** to a shippable menu-bar HUD (vs 1–2 weeks for the full workbench).
