// ClipboardTool（Tauri 重写）主进程编排。
// 移植自 electron/main.js：剪贴板轮询与去重基线、持久化、托盘（DPI/主题自适应）、
// 面板窗口管理（呼出/隐藏/离屏驻留/浏览态自动失焦）、计划任务（静默提权/开机启动）、
// 全局热键、全局点击监听、IPC 命令。
//
// 与 Electron 版的结构差异：
// - 4 个 C# 助手进程（focus-paste / app-icon / click-watcher / task-launcher）全部退役，
//   对应逻辑成为本进程内的模块（focus_paste / source_app / click_watcher / tasks）。
// - 面板模式状态机（panel_modes）经 ModesHost trait 注入效果；焦点快照从异步 JSON-RPC
//   变为同步 Win32 调用。
// - 数据目录沿用 %APPDATA%\ClipboardTool，与 Electron 版共享历史 JSON 与图片文件。
//
// 线程模型（死锁防线的核心，改动前必读）：
// - tauri-plugin-global-shortcut 的 register/unregister 内部是「投递主线程 + 阻塞等待」
//   （run_main_thread! 宏：run_on_main_thread + mpsc recv）。谁在持有 modes 锁时调用它，
//   而主线程恰好在等这把锁（如点击面板后的 Focused 事件任务），就构成互等死锁
//   （历史上表现为「点击复制并粘贴 → 无响应卡死」）。
// - 因此面板模式状态机由专用执行线程（ModesExecutor）独占：所有模式操作单向投递过去，
//   主线程只读无锁原子快照（modes_visible / modes_input_active），绝不阻塞在模式上；
//   执行线程调用插件时主线程必然空闲，插件的内嵌投递总能完成 → 无循环等待。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod click_watcher;
mod focus_paste;
mod history;
mod panel_modes;
mod source_app;
mod settings;
mod startup;
mod tasks;

use history::{EntryType, HistoryStore, HistoryStoreBuilder, SourceApp};
use settings::Settings;
use panel_modes::{FocusTarget, HotkeyAction, Mode, ModesHost, PanelModes};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc as std_mpsc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, Position, State, Theme, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use base64::Engine as _;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_TRANSPARENT,
};

const POLL_INTERVAL: Duration = Duration::from_millis(600);
const PANEL_WIDTH: f64 = 418.0;
const PANEL_HEIGHT: f64 = 823.0;
const TRAY_ICON_SIZES: [u32; 5] = [16, 20, 24, 28, 32];
const PANEL_LABEL: &str = "panel";
const TRAY_ID: &str = "main-tray";

struct AppState {
    store: Mutex<HistoryStore>,
    // 面板模式状态机的唯一入口（独占执行线程），绝不从主线程/命令线程直接加锁
    modes_exec: ModesExecutor,
    // 主线程使用的无锁快照（执行线程在每次模式操作后刷新）
    modes_visible: AtomicBool,
    modes_input_active: AtomicBool,
    settings: Mutex<Settings>,
    // exePath -> dataUrl（None = 提取失败的负缓存）
    icon_cache: Mutex<HashMap<String, Option<String>>>,
    // imagePath -> dataUrl：broadcast 时读盘+base64 的永久缓存（图片文件创建后内容不变）；
    // Arc 共享给 store 的 remove_image_file 端口（删除/裁剪时同步失效）
    image_url_cache: Arc<Mutex<HashMap<String, String>>>,
    last_text: Mutex<String>,
    last_image_hash: Mutex<String>,
    last_seq: Mutex<u32>,
    // recordImage 写盘失败时置位：即使序列号未变也要重试一次轮询
    poll_retry: AtomicBool,
    hotkeys: Mutex<HashMap<Shortcut, String>>, // Shortcut -> accel（host 注册的记录，供分发）
    data_dir: PathBuf,
    tray_icon_key: Mutex<String>,
}

// ---------- 渲染层数据契约（与 src/types.ts 对齐） ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RendererEntry {
    id: String,
    #[serde(rename = "type")]
    entry_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data_url: Option<String>,
    created_at: u64,
    source_app: Option<SourceApp>,
    pinned: bool,
    pinned_at: u64,
    note: String,
}

#[derive(Debug, Clone, Serialize)]
struct CopyResult {
    ok: bool,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
struct ShortcutTryResult {
    ok: bool,
    formatted: String,
}

#[derive(Debug, Clone, Serialize)]
struct FocusErrorPayload {
    stage: String,
    reason: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
struct PanelKeyPayload {
    action: String,
    #[serde(rename = "noteEntryId")]
    note_entry_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ShortcutCaptureStartPayload {
    current: String,
}

// ---------- 数据目录（与 Electron 版共享：%APPDATA%\ClipboardTool） ----------

fn data_dir() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    Path::new(&base).join("ClipboardTool")
}

fn history_file(state: &AppState) -> PathBuf {
    state.data_dir.join("clipboard-history.json")
}

fn settings_file(state: &AppState) -> PathBuf {
    state.data_dir.join("settings.json")
}

fn save_settings(state: &AppState, settings: &Settings) {
    if let Err(err) = settings::save(&settings_file(state), settings) {
        eprintln!("Failed to save settings: {err}");
    }
}

// ---------- 诊断日志 ----------

pub(crate) fn diag_log(msg: &str) {
    if std::env::var("CLIPBOARD_TOOL_DIAG").is_err() {
        return;
    }
    let dir = data_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) =
        std::fs::OpenOptions::new().create(true).append(true).open(dir.join("diag.log"))
    {
        use std::io::Write;
        let line = format!("[{:?}] {}\n", std::time::SystemTime::now(), msg);
        let _ = f.write_all(line.as_bytes());
    }
}

fn poll_trace(msg: &str) {
    if std::env::var("CLIPBOARD_TOOL_POLL_TRACE").is_ok() {
        eprintln!("[poll] {msg}");
    }
}

// ---------- 渲染层投影 ----------

fn to_renderer_entry(state: &AppState, entry: &history::Entry) -> Option<RendererEntry> {
    match entry.entry_type {
        EntryType::Image => {
            let path = entry.image_path.as_ref()?;
            let data_url = {
                let mut cache = state.image_url_cache.lock().unwrap();
                match cache.get(path) {
                    Some(url) => Some(url.clone()),
                    None => std::fs::read(path).ok().and_then(|bytes| {
                        let url = format!(
                            "data:image/png;base64,{}",
                            base64::engine::general_purpose::STANDARD.encode(bytes)
                        );
                        cache.insert(path.clone(), url.clone());
                        Some(url)
                    }),
                }
            }?;
            Some(RendererEntry {
                id: entry.id.clone(),
                entry_type: "image",
                text: None,
                data_url: Some(data_url),
                created_at: entry.created_at,
                source_app: entry.source_app.clone(),
                pinned: entry.pinned,
                pinned_at: entry.pinned_at,
                note: entry.note.clone(),
            })
        }
        EntryType::Text => Some(RendererEntry {
            id: entry.id.clone(),
            entry_type: "text",
            text: Some(entry.text.clone().unwrap_or_default()),
            data_url: None,
            created_at: entry.created_at,
            source_app: entry.source_app.clone(),
            pinned: entry.pinned,
            pinned_at: entry.pinned_at,
            note: entry.note.clone(),
        }),
    }
}

fn persist(state: &AppState) {
    let json = {
        let store = state.store.lock().unwrap();
        serde_json::to_string(&store.to_json())
    };
    match json {
        Ok(json) => {
            if let Err(err) = std::fs::write(history_file(state), json) {
                eprintln!("Failed to persist history: {err}");
            }
        }
        Err(err) => eprintln!("Failed to serialize history: {err}"),
    }
}

fn broadcast(app: &AppHandle, state: &AppState) {
    let Some(win) = app.get_webview_window(PANEL_LABEL) else { return };
    let entries: Vec<RendererEntry> = {
        let store = state.store.lock().unwrap();
        store
            .entries()
            .iter()
            .filter_map(|e| to_renderer_entry(state, e))
            .collect()
    };
    let _ = win.emit("clipboard:updated", entries);
}

// 一次变更 = store 方法 + commit()（persist + broadcast）
fn commit(app: &AppHandle, state: &AppState) {
    persist(state);
    broadcast(app, state);
}

// ---------- 剪贴板效果 ----------

// 读剪贴板图片并编码 PNG（与 Electron clipboard.readImage().toPNG() 对齐）
fn clipboard_read_image_png(clip: &mut arboard::Clipboard) -> Option<Vec<u8>> {
    let img = clip.get_image().ok()?;
    let mut buf = image::RgbaImage::new(img.width as u32, img.height as u32);
    for (px, src) in buf.pixels_mut().zip(img.bytes.chunks_exact(4)) {
        *px = image::Rgba([src[0], src[1], src[2], src[3]]);
    }
    let mut png = Vec::new();
    buf.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .ok()?;
    Some(png)
}

fn write_clipboard_text(text: &str) -> bool {
    let Ok(mut clip) = arboard::Clipboard::new() else { return false };
    clip.set_text(text.to_string()).is_ok()
}

fn write_clipboard_image_file(path: &str) -> bool {
    let Ok(bytes) = std::fs::read(path) else { return false };
    let Ok(decoded) = image::load_from_memory(&bytes) else { return false };
    let rgba = decoded.to_rgba8();
    let (w, h) = (rgba.width() as usize, rgba.height() as usize);
    let data = arboard::ImageData {
        width: w,
        height: h,
        bytes: std::borrow::Cow::Owned(rgba.into_raw()),
    };
    let Ok(mut clip) = arboard::Clipboard::new() else { return false };
    clip.set_image(data).is_ok()
}

// 剪贴板序列号：Win32 全局计数器，任何写剪贴板操作都会 +1。
// 读取不需要打开剪贴板——用它短路未变化的轮询，既省 CPU 又减少与其他程序的
// 剪贴板打开争用（Electron 版每 600ms 无条件 readImage+toPNG，此处为改进项）。
fn clipboard_seq() -> u32 {
    unsafe { windows::Win32::System::DataExchange::GetClipboardSequenceNumber() }
}

// 轮询基线：读当前剪贴板内容，避免启动后首个轮询把"已在剪贴板里"的内容当作新复制
fn sync_baseline(state: &AppState) {
    let Ok(mut clip) = arboard::Clipboard::new() else { return };
    let mut last_image_hash = state.last_image_hash.lock().unwrap();
    let mut last_text = state.last_text.lock().unwrap();
    match clipboard_read_image_png(&mut clip) {
        Some(png) if !png.is_empty() => {
            *last_image_hash = history::sha1_hex(&png);
            *last_text = clip.get_text().map(|t| t).unwrap_or_default();
        }
        _ => {
            *last_text = clip.get_text().map(|t| t).unwrap_or_default();
            *last_image_hash = String::new();
        }
    }
    *state.last_seq.lock().unwrap() = clipboard_seq();
}

fn current_source_app(state: &AppState) -> Option<SourceApp> {
    let mut icon_cache = state.icon_cache.lock().unwrap();
    source_app::get_foreground_app_info(&mut icon_cache).map(|info| SourceApp {
        exe_path: info.exe_path,
        app_name: info.app_name,
        window_title: info.window_title,
        icon_data_url: info.icon_data_url,
    })
}

// 与 main.js pollClipboard 逐段对齐
fn poll_once(app: &AppHandle, state: &AppState) {
    poll_trace("new");
    let Ok(mut clip) = arboard::Clipboard::new() else {
        poll_trace("clipboard-open-failed");
        return;
    };
    poll_trace("opened");
    if let Some(png) = clipboard_read_image_png(&mut clip) {
        if !png.is_empty() {
            let hash = history::sha1_hex(&png);
            let changed = hash != *state.last_image_hash.lock().unwrap();
            poll_trace(&format!("image len={} hash-changed={}", png.len(), changed));
            if changed {
                let source_app = current_source_app(state);
                let recorded = {
                    let mut store = state.store.lock().unwrap();
                    let out = store.record_image(&png, source_app);
                    out.entry.is_some()
                };
                if recorded {
                    *state.last_image_hash.lock().unwrap() = hash;
                    state.poll_retry.store(false, Ordering::SeqCst);
                    commit(app, state);
                } else {
                    // 写盘失败：不动轮询基线，置重试标志，下个轮询重试
                    state.poll_retry.store(true, Ordering::SeqCst);
                    return;
                }
            }
            *state.last_text.lock().unwrap() = clip.get_text().map(|t| t).unwrap_or_default();
            return;
        }
    }
    let text = clip.get_text().map(|t| t).unwrap_or_default();
    let text_changed = !text.is_empty() && text != *state.last_text.lock().unwrap();
    poll_trace(&format!("text len={} changed={}", text.len(), text_changed));
    if text_changed {
        let source_app = current_source_app(state);
        let recorded = {
            let mut store = state.store.lock().unwrap();
            let out = store.record_text(&text, source_app);
            out.entry.is_some()
        };
        if recorded {
            commit(app, state);
        }
    }
    *state.last_text.lock().unwrap() = text;
    *state.last_image_hash.lock().unwrap() = String::new();
    state.poll_retry.store(false, Ordering::SeqCst);
}

fn poll_loop(app: AppHandle) {
    loop {
        std::thread::sleep(POLL_INTERVAL);
        let state = app.state::<AppState>();
        // 序列号未变且没有待重试的写盘失败 → 本轮无需读剪贴板
        let seq = clipboard_seq();
        let retry_pending = state.poll_retry.load(Ordering::SeqCst);
        if seq != 0 && !retry_pending && seq == *state.last_seq.lock().unwrap() {
            continue;
        }
        // 轮询线程要面对任意应用写入的剪贴板内容：单次异常只记录并跳过，不允许杀死轮询
        let app2 = app.clone();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            poll_once(&app2, &state);
        }));
        *state.last_seq.lock().unwrap() = clipboard_seq();
        if let Err(panic) = result {
            let msg = panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "unknown panic".to_string());
            eprintln!("poll_once panicked (skipped this round): {msg}");
        }
    }
}

// ---------- 焦点错误文案（唯一映射处） ----------

fn focus_error_message(stage: &str) -> &'static str {
    if stage == "paste" {
        "复制已写入剪贴板，但无法粘贴回原输入框，请重试。"
    } else {
        "无法恢复原输入框，已取消本次粘贴，避免写入错误窗口。"
    }
}

fn send_focus_error(app: &AppHandle, stage: &str, reason: &str) {
    let Some(win) = app.get_webview_window(PANEL_LABEL) else { return };
    let _ = win.emit(
        "panel:focus-error",
        FocusErrorPayload {
            stage: stage.to_string(),
            reason: reason.to_string(),
            message: focus_error_message(stage).to_string(),
        },
    );
}

// ---------- 面板窗口管理 ----------

fn panel_window(app: &AppHandle) -> Option<tauri::WebviewWindow<Wry>> {
    app.get_webview_window(PANEL_LABEL)
}

// 显示器物理工作区（扣除任务栏）
fn monitor_work_area(m: &tauri::Monitor) -> (i32, i32, i32, i32) {
    let wa = m.work_area();
    (wa.position.x, wa.position.y, wa.size.width as i32, wa.size.height as i32)
}

fn monitor_scale_at(app: &AppHandle, x: i32, y: i32) -> Option<f64> {
    let monitors = app.available_monitors().ok()?;
    for m in monitors {
        let pos = m.position();
        let size = m.size();
        if x >= pos.x && x < pos.x + size.width as i32 && y >= pos.y && y < pos.y + size.height as i32
        {
            return Some(m.scale_factor());
        }
    }
    None
}

// 窗口几何/焦点等变更统一投递主线程执行：跨线程直接调用会向主线程同步发送消息，
// 一旦主线程同时在等待我们的锁（热键/点击/命令路径都持有状态锁）即互相等待死锁
// （表现为窗口"无响应"）。
fn position_panel(app: &AppHandle) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || position_panel_on_main(&app2));
}

fn position_panel_on_main(app: &AppHandle) {
    let Some(win) = panel_window(app) else { return };
    let Ok(cursor) = app.cursor_position() else { return };
    // 光标所在显示器的工作区居中；用固定面板尺寸避免离屏 DPI 漂移
    let Some(monitor) = app
        .available_monitors()
        .ok()
        .and_then(|ms| {
            ms.into_iter()
                .find(|m| {
                    let p = m.position();
                    let s = m.size();
                    cursor.x as i32 >= p.x
                        && (cursor.x as i32) < p.x + s.width as i32
                        && cursor.y as i32 >= p.y
                        && (cursor.y as i32) < p.y + s.height as i32
                })
        })
        .or_else(|| win.current_monitor().ok().flatten())
    else {
        return;
    };
    let scale = monitor.scale_factor();
    let (ax, ay, aw, ah) = monitor_work_area(&monitor);
    let area_x = ax as f64 / scale;
    let area_y = ay as f64 / scale;
    let area_w = aw as f64 / scale;
    let area_h = ah as f64 / scale;
    let nx = (area_x + (area_w - PANEL_WIDTH) / 2.0).round();
    let ny = (area_y + (area_h - PANEL_HEIGHT) / 2.0).round();
    let _ = win.set_position(Position::Logical(LogicalPosition::new(nx, ny)));
}

// 隐藏到当前显示器工作区右侧 20 DIP（保持同屏 DPI，避免跨屏漂移）
fn move_panel_offscreen(app: &AppHandle) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || move_panel_offscreen_on_main(&app2));
}

fn move_panel_offscreen_on_main(app: &AppHandle) {
    let Some(win) = panel_window(app) else { return };
    let (hx, hy) = match win.current_monitor().ok().flatten() {
        Some(m) => {
            let (ax, ay, aw, _ah) = monitor_work_area(&m);
            let s = m.scale_factor();
            ((ax as f64 + aw as f64) / s + 20.0, ay as f64 / s)
        }
        None => (-10000.0, 0.0),
    };
    let _ = win.set_position(Position::Logical(LogicalPosition::new(hx, hy)));
}

// 把焦点还给原程序（仅当面板当前持有焦点时）：Electron win.blur() 等价于 SetFocus(NULL)，
// 必须在窗口归属线程调用
fn release_panel_focus(app: &AppHandle) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(win) = panel_window(&app2) else { return };
        if win.is_focused().unwrap_or(false) {
            unsafe {
                // SetFocus(NULL) 失败（无持有焦点的窗口）可安全忽略
                let _ = SetFocus(None);
            }
        }
    });
}

// ---------- 模式状态机效果宿主（仅在执行线程上使用） ----------

struct ModesHostImpl {
    app: AppHandle,
}

impl ModesHostImpl {
    fn new(app: &AppHandle) -> Self {
        ModesHostImpl { app: app.clone() }
    }
}

impl ModesHost for ModesHostImpl {
    fn register_key(&mut self, accel: &str, _action: HotkeyAction) -> bool {
        let Ok(shortcut) = accel.to_string().parse::<Shortcut>() else {
            eprintln!("注册全局快捷键 {accel} 失败：无法解析");
            return false;
        };
        let state = self.app.state::<AppState>();
        {
            let hotkeys = state.hotkeys.lock().unwrap();
            if hotkeys.contains_key(&shortcut) {
                return false;
            }
        }
        // 插件内部会投递主线程并阻塞等待——本方法只在执行线程上调用，主线程永远空闲可处理
        let ok = self.app.global_shortcut().register(shortcut).is_ok();
        if ok {
            state.hotkeys.lock().unwrap().insert(shortcut, accel.to_string());
        } else {
            eprintln!("注册全局快捷键 {accel} 失败（可能被其他程序占用）");
        }
        ok
    }

    fn unregister_key(&mut self, accel: &str) {
        let state = self.app.state::<AppState>();
        let shortcut = {
            let hotkeys = state.hotkeys.lock().unwrap();
            hotkeys
                .iter()
                .find(|(_, a)| a.as_str() == accel)
                .map(|(s, _)| *s)
        };
        if let Some(shortcut) = shortcut {
            let _ = self.app.global_shortcut().unregister(shortcut);
            state.hotkeys.lock().unwrap().remove(&shortcut);
        }
    }

    fn can_interact(&self) -> bool {
        panel_window(&self.app).is_some()
    }

    fn focus_panel(&self) {
        let app1 = self.app.clone();
        let app2 = app1.clone();
        let _ = app1.run_on_main_thread(move || {
            if let Some(win) = panel_window(&app2) {
                let _ = win.set_focus();
            }
        });
    }

    fn blur_panel_if_focused(&self) {
        release_panel_focus(&self.app);
    }

    fn send_panel_key(&self, action: &str, note_entry_id: Option<&str>) {
        let Some(win) = panel_window(&self.app) else { return };
        let _ = win.emit(
            "panel:key",
            PanelKeyPayload {
                action: action.to_string(),
                note_entry_id: note_entry_id.map(|s| s.to_string()),
            },
        );
    }

    fn send_panel_shown(&self) {
        let Some(win) = panel_window(&self.app) else { return };
        let _ = win.emit("panel:shown", ());
    }

    fn send_capture_end(&self) {
        let Some(win) = panel_window(&self.app) else { return };
        let _ = win.emit("shortcut:capture-end", ());
    }

    fn capture_focus(&self) -> Option<FocusTarget> {
        focus_paste::snapshot().ok()
    }

    fn restore_focus(&self, target: &FocusTarget) {
        if let Err(failure) = focus_paste::restore_and_paste(target, false) {
            send_focus_error(&self.app, failure.stage, failure.reason);
        }
    }

    fn report_no_focus_target(&self) {
        send_focus_error(&self.app, "restore", "no_focus_target");
    }

    fn validate_note_target(&self, target_id: Option<&str>) -> bool {
        let state = self.app.state::<AppState>();
        let store = state.store.lock().unwrap();
        match target_id {
            None => !store.is_empty(),
            Some(id) => store.find(id).is_some(),
        }
    }

    fn on_toggle_requested(&self) {
        // Toggle 统一由 dispatch_hotkey 在执行线程上处理（&self 拿不到 &mut PanelModes）；
        // 本方法为 trait 完整性保留
    }
}

// ---------- 模式状态机执行线程 ----------

type ModesJob = Box<dyn FnOnce(&mut PanelModes, &mut ModesHostImpl) + Send>;

struct ModesExecutor {
    tx: std_mpsc::Sender<ModesJob>,
}

impl ModesExecutor {
    fn new(_app: &AppHandle) -> (Self, std_mpsc::Receiver<ModesJob>) {
        let (tx, rx) = std_mpsc::channel::<ModesJob>();
        (ModesExecutor { tx }, rx)
    }

    // 独占执行线程：模式操作串行化在唯一线程上，主线程/命令线程/点击线程只投递不等待锁。
    // 每个任务结束后刷新主线程使用的无锁快照。
    fn spawn_worker(app: AppHandle, rx: std_mpsc::Receiver<ModesJob>) {
        let _ = std::thread::Builder::new().name("modes-executor".into()).spawn(move || {
            let mut modes = PanelModes::new();
            let mut host = ModesHostImpl::new(&app);
            while let Ok(job) = rx.recv() {
                job(&mut modes, &mut host);
                let st = modes.state();
                if let Some(state) = app.try_state::<AppState>() {
                    state.modes_visible.store(st.visible, Ordering::Relaxed);
                    state
                        .modes_input_active
                        .store(st.visible && st.mode != Mode::Browse, Ordering::Relaxed);
                }
            }
        });
    }

    // 投递并等待结果（仅 async 命令线程使用；插件内嵌的主线程投递总能完成，无死锁）
    fn exec<R, F>(&self, f: F) -> tokio::sync::oneshot::Receiver<R>
    where
        F: FnOnce(&mut PanelModes, &mut ModesHostImpl) -> R + Send + 'static,
        R: Send + 'static,
    {
        let (rtx, rrx) = tokio::sync::oneshot::channel();
        let _ = self.tx.send(Box::new(move |modes, host| {
            let _ = rtx.send(f(modes, host));
        }));
        rrx
    }

    // 投递不等待（热键分发/点击/托盘等回调线程使用；回调必须立即返回）
    fn exec_now<F>(&self, f: F)
    where
        F: FnOnce(&mut PanelModes, &mut ModesHostImpl) + Send + 'static,
    {
        let _ = self.exec(f);
    }
}

// 以下 *_on 系列只在执行线程的任务闭包内调用（持有 &mut PanelModes）。

fn show_panel_on(app: &AppHandle, modes: &mut PanelModes, host: &mut ModesHostImpl, capture: bool) {
    diag_log(&format!("show_panel capture={capture}"));
    if capture {
        // 呼出时序：先记录前台窗口与焦点控件，再显示面板（失败静默，面板照常显示）
        modes.ensure_focus_target(host, false);
    }
    position_panel(app);
    // 模式状态机负责：重置搜索/备注态、推导注册导航键、通知渲染层（panel:shown）
    modes.show(host);
    // 不在这里 broadcast()：历史由 600ms 轮询实时推送，呼出时强制刷新反而导致列表重绘闪烁
}

fn hide_panel_on(app: &AppHandle, modes: &mut PanelModes, host: &mut ModesHostImpl, restore_focus: bool) {
    diag_log(&format!("hide_panel restore_focus={restore_focus}"));
    // 模式状态机负责：逐层退出捕获/备注/搜索（发对退出事件）、注销导航键、消费焦点快照
    modes.hide(host, restore_focus);
    move_panel_offscreen(app);
}

fn toggle_panel_on(app: &AppHandle, modes: &mut PanelModes, host: &mut ModesHostImpl) {
    if modes.is_panel_visible() {
        hide_panel_on(app, modes, host, true);
    } else {
        show_panel_on(app, modes, host, true);
    }
}

// ---------- 全局点击监听（回调线程 → 投递执行线程） ----------

fn handle_global_click(app: &AppHandle, x: i32, y: i32) {
    let state = app.state::<AppState>();
    let app2 = app.clone();
    state.modes_exec.exec_now(move |modes, host| {
        if !modes.is_panel_visible() {
            return;
        }
        let Some(win) = panel_window(&app2) else { return };
        // 钩子坐标是物理像素，转成 DIP 再和窗口边界（DIP）比较
        let scale =
            monitor_scale_at(&app2, x, y).or_else(|| win.scale_factor().ok()).unwrap_or(1.0);
        let dip_x = x as f64 / scale;
        let dip_y = y as f64 / scale;
        let Ok(pos) = win.outer_position() else { return };
        let Ok(size) = win.outer_size() else { return };
        let win_scale = win.scale_factor().unwrap_or(scale);
        let bx = pos.x as f64 / win_scale;
        let by = pos.y as f64 / win_scale;
        let bw = size.width as f64 / win_scale;
        let bh = size.height as f64 / win_scale;
        diag_log(&format!(
            "click phys=({x},{y}) scale={scale} dip=({dip_x:.1},{dip_y:.1}) bounds=({bx:.1},{by:.1},{bw:.1},{bh:.1}) pos=({},{}) size=({},{})",
            pos.x, pos.y, size.width, size.height
        ));
        if dip_x >= bx && dip_x <= bx + bw && dip_y >= by && dip_y <= by + bh {
            return;
        }
        hide_panel_on(&app2, modes, host, true);
    });
}

// ---------- 全局快捷键分发（插件回调线程 → 投递执行线程） ----------

fn dispatch_hotkey(app: &AppHandle, accel: &str) {
    diag_log(&format!("dispatch_hotkey accel={accel}"));
    let state = app.state::<AppState>();
    let accel = accel.to_string();
    let app2 = app.clone();
    state.modes_exec.exec_now(move |modes, host| match modes.registered_action_for(&accel) {
        Some(HotkeyAction::Toggle) => toggle_panel_on(&app2, modes, host),
        Some(HotkeyAction::Nav(nav)) => modes.on_nav_action(host, nav),
        None => {}
    });
}

// ---------- 托盘 ----------

fn tray_icon_image(dark_theme: bool, scale: f64) -> Option<tauri::image::Image<'static>> {
    // 与 main.js 相同：按主屏 scaleFactor 选「恰好 round(16*scale) 物理像素」的单一尺寸图，
    // HICON 1:1 渲染零重采样（深色任务栏用白色图标，浅色用黑色图标）
    let target = (16.0 * scale).round() as i32;
    let size = *TRAY_ICON_SIZES
        .iter()
        .min_by_key(|&&s| (s as i32 - target).abs())
        .unwrap_or(&32);
    let bytes: &[u8] = match (dark_theme, size) {
        (true, 16) => include_bytes!("../icons/tray/tray-icon-light-16.png"),
        (true, 20) => include_bytes!("../icons/tray/tray-icon-light-20.png"),
        (true, 24) => include_bytes!("../icons/tray/tray-icon-light-24.png"),
        (true, 28) => include_bytes!("../icons/tray/tray-icon-light-28.png"),
        (true, 32) => include_bytes!("../icons/tray/tray-icon-light-32.png"),
        (false, 16) => include_bytes!("../icons/tray/tray-icon-16.png"),
        (false, 20) => include_bytes!("../icons/tray/tray-icon-20.png"),
        (false, 24) => include_bytes!("../icons/tray/tray-icon-24.png"),
        (false, 28) => include_bytes!("../icons/tray/tray-icon-28.png"),
        (false, 32) => include_bytes!("../icons/tray/tray-icon-32.png"),
        _ => include_bytes!("../icons/tray-icon.png"), // 缺分尺寸图时回退 32px 基图
    };
    tauri::image::Image::from_bytes(bytes).ok()
}

fn window_icon_image(dark_theme: bool) -> Option<tauri::image::Image<'static>> {
    // 窗口图标跟随系统主题切换（走 32px 基图：窗口图标路径由系统多尺寸缩放，无托盘 HICON 问题）
    let bytes: &[u8] = if dark_theme {
        include_bytes!("../icons/tray-icon-light.png")
    } else {
        include_bytes!("../icons/tray-icon.png")
    };
    tauri::image::Image::from_bytes(bytes).ok()
}

fn update_tray_icon(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let state = app.state::<AppState>();
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    let dark = panel_window(app)
        .and_then(|w| w.theme().ok())
        .map(|t| t == Theme::Dark)
        .unwrap_or(false);
    // 同主题同尺寸时跳过，display-metrics 高频触发也不重复 setImage
    let key = format!("{}@{}", if dark { "light" } else { "dark" }, (16.0 * scale).round() as i32);
    {
        let mut last = state.tray_icon_key.lock().unwrap();
        if *last == key {
            return;
        }
        let Some(icon) = tray_icon_image(dark, scale) else { return };
        *last = key;
        let _ = tray.set_icon(Some(icon));
    }
    update_window_icon(app, dark);
}

fn update_window_icon(app: &AppHandle, dark: bool) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(win) = panel_window(&app2) else { return };
        if let Some(icon) = window_icon_image(dark) {
            let _ = win.set_icon(icon);
        }
    });
}

fn build_tray_menu(app: &AppHandle, state: &AppState) -> tauri::Result<Menu<Wry>> {
    let settings = state.settings.lock().unwrap();
    let show_item = MenuItem::with_id(app, "show", "显示剪贴板面板", true, None::<&str>)?;
    let shortcut_label = format!("更换快捷键(当前: {})", format_shortcut(&settings.shortcut));
    let shortcut_item = MenuItem::with_id(app, "change-shortcut", shortcut_label, true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let autostart_label = format!("开机启动 {}", if settings.auto_start { "✅" } else { "❌" });
    let autostart_item =
        CheckMenuItem::with_id(app, "autostart", autostart_label, true, settings.auto_start, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    Menu::with_items(app, &[&show_item, &shortcut_item, &sep1, &autostart_item, &sep2, &quit])
}

fn rebuild_tray_menu(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        match build_tray_menu(app, &state) {
            Ok(menu) => {
                let _ = tray.set_menu(Some(menu));
            }
            Err(err) => eprintln!("重建托盘菜单失败: {err}"),
        }
    }
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    let dark = panel_window(app)
        .and_then(|w| w.theme().ok())
        .map(|t| t == Theme::Dark)
        .unwrap_or(false);
    let icon = tray_icon_image(dark, scale).ok_or_else(|| std::io::Error::other("tray icon missing"))?;
    let menu = build_tray_menu(app, &state)?;
    let _tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("剪贴板工具")
        .menu(&menu)
        // 左键点击呼出面板（与 Electron tray.on('click') 一致），菜单走右键
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                let state = app.state::<AppState>();
                let app2 = app.clone();
                state.modes_exec.exec_now(move |modes, host| show_panel_on(&app2, modes, host, true));
            }
            "change-shortcut" => start_shortcut_capture(app),
            "autostart" => {
                let state = app.state::<AppState>();
                let enabled = !state.settings.lock().unwrap().auto_start;
                set_auto_start(app, enabled);
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::Click { .. } | TrayIconEvent::DoubleClick { .. }) {
                let app = tray.app_handle();
                let state = app.state::<AppState>();
                let app2 = app.clone();
                state
                    .modes_exec
                    .exec_now(move |modes, host| show_panel_on(&app2, modes, host, true));
            }
        })
        .build(app)?;
    update_tray_icon(app);
    update_window_icon(app, dark);
    Ok(())
}

// ---------- 快捷键 ----------

fn format_shortcut(accel: &str) -> String {
    // Control+Shift+V -> Ctrl + Shift + V
    let accel = if accel.is_empty() { settings::DEFAULT_SHORTCUT } else { accel };
    accel
        .split('+')
        .map(|part| match part {
            "Control" | "CommandOrControl" => "Ctrl",
            "Super" | "Meta" => "Win",
            "Alt" => "Alt",
            "Shift" => "Shift",
            other => other,
        })
        .collect::<Vec<_>>()
        .join(" + ")
}

// 开始更换快捷键：进入捕获模式（模式机先退出其它输入态并注销全部全局键），
// 随后显示面板并聚焦，让渲染进程捕获按键。
// 在托盘菜单回调（主线程）触发：只投递执行线程，回调立即返回。
fn start_shortcut_capture(app: &AppHandle) {
    let state = app.state::<AppState>();
    let app2 = app.clone();
    state.modes_exec.exec_now(move |modes, host| {
        if !modes.begin_shortcut_capture(host) {
            return;
        }
        show_panel_on(&app2, modes, host, false);
        let Some(win) = panel_window(&app2) else { return };
        // 捕获按键前聚焦面板（基线 focusable:true，直接 focus 即可；投递主线程执行）
        host.focus_panel();
        let current = format_shortcut(&app2.state::<AppState>().settings.lock().unwrap().shortcut);
        let _ = win.emit("shortcut:capture-start", ShortcutCaptureStartPayload { current });
    });
}

// ---------- 开机启动（意图落盘 + 事实重建；通道判定与顺序契约见 startup module） ----------

// 启动时按持久化意图重建静默启动通道（dev 下内部为 no-op）
fn apply_startup_intent(app: &AppHandle) {
    let state = app.state::<AppState>();
    let intent = state.settings.lock().unwrap().auto_start;
    let outcome = startup::apply_intent(intent);
    diag_log(&format!("apply_startup_intent intent={intent} -> {outcome:?}"));
    // 正常路径静默；意图没落成事实时（推迟/失败）才提示，否则用户以为开关已生效
    if outcome.deferred || outcome.effective != intent {
        eprintln!("{}", outcome.message);
    }
}

// 开机启动开关：意图先落盘，事实尽力重建；建不了时保留意图等下次提权启动补建
fn set_auto_start(app: &AppHandle, want: bool) {
    let state = app.state::<AppState>();
    let applied = startup::set_auto_start(want);
    {
        let mut settings = state.settings.lock().unwrap();
        settings.auto_start = applied.effective;
        save_settings(&state, &settings);
    }
    rebuild_tray_menu(app);
    println!("开机启动: {} — {}", if applied.effective { "✅" } else { "❌" }, applied.message);
    diag_log(&format!("set_auto_start want={want} applied={applied:?}"));
}

// ---------- IPC 命令 ----------

enum CopyContent {
    Text(String),
    Image(String),
}

#[tauri::command]
fn clipboard_get(state: State<AppState>) -> Vec<RendererEntry> {
    let store = state.store.lock().unwrap();
    store.entries().iter().filter_map(|e| to_renderer_entry(&state, e)).collect()
}

// 复制并粘贴：三个入口（键盘 Enter / 双击 / 复制按钮）共用同一个结果契约
// { ok, message }，渲染层按契约渲染，错误文案与 panel:focus-error 事件同源。
// 模式相关片段投递执行线程；粘贴注入（慢、纯 Win32）留在命令线程，不持有任何状态锁。
#[tauri::command]
async fn clipboard_copy(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<CopyResult, String> {
    diag_log(&format!("copy: invoked id={id}"));
    let not_found = || CopyResult {
        ok: false,
        message: "条目不存在或内容已不可用。".to_string(),
    };
    // 1) 取条目内容（store 短暂锁定，不与模式状态交叉）
    let content = {
        let store = state.store.lock().unwrap();
        match store.find(&id) {
            Some(entry) => match entry.entry_type {
                EntryType::Text => CopyContent::Text(entry.text.clone().unwrap_or_default()),
                EntryType::Image => match &entry.image_path {
                    Some(path) => CopyContent::Image(path.clone()),
                    None => return Ok(not_found()),
                },
            },
            None => return Ok(not_found()),
        }
    };
    // 2) 写剪贴板
    let write_ok = match &content {
        CopyContent::Text(text) => write_clipboard_text(text),
        CopyContent::Image(path) => write_clipboard_image_file(path),
    };
    diag_log(&format!("copy: clipboard write_ok={write_ok}"));
    if !write_ok {
        return Ok(not_found());
    }
    // 3) 复制后的落位与去重提升是同一规则（置顶刷新 pinnedAt 移块首；普通移普通块最前）
    {
        let mut store = state.store.lock().unwrap();
        store.promote(&id);
    }
    commit(&app, &state);
    // 同步轮询基线：刚写进剪贴板的内容不应在下一个 600ms 轮询里被当成"新复制"
    // 再次提升+广播（一次多余的全列表重绘，也是粘贴后闪烁的来源）
    sync_baseline(&state);
    // 4) 恢复原窗口焦点并注入 Ctrl+V
    let target = state
        .modes_exec
        .exec(|m, _h| m.focus_target_snapshot_cloned())
        .await
        .unwrap_or(None);
    let Some(target) = target else {
        send_focus_error(&app, "restore", "no_focus_target");
        return Ok(CopyResult { ok: false, message: focus_error_message("restore").to_string() });
    };
    diag_log("copy: restore+paste begin");
    match focus_paste::restore_and_paste(&target, true) {
        Ok(()) => {
            diag_log("copy: pasted ok -> hide");
            let app2 = app.clone();
            let _ = state.modes_exec.exec(move |m, h| hide_panel_on(&app2, m, h, false)).await; // restoreFocus: false
            Ok(CopyResult { ok: true, message: "已复制并粘贴".to_string() })
        }
        Err(failure) => {
            diag_log(&format!("copy: restore failed stage={} reason={}", failure.stage, failure.reason));
            send_focus_error(&app, failure.stage, failure.reason);
            Ok(CopyResult { ok: false, message: focus_error_message(failure.stage).to_string() })
        }
    }
}

#[tauri::command]
async fn clipboard_remove(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let removed = {
        let mut store = state.store.lock().unwrap();
        store.remove(&id)
    };
    if !removed {
        return Ok(false);
    }
    commit(&app, &state);
    Ok(true)
}

#[tauri::command]
async fn clipboard_pin(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let toggled = {
        let mut store = state.store.lock().unwrap();
        store.toggle_pin(&id)
    };
    if !toggled {
        return Ok(false);
    }
    commit(&app, &state);
    Ok(true)
}

#[tauri::command]
async fn clipboard_clear(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    {
        let mut store = state.store.lock().unwrap();
        store.clear();
    }
    commit(&app, &state);
    Ok(true)
}

// 备注：保存、进入编辑、退出编辑
#[tauri::command]
async fn note_set(app: AppHandle, state: State<'_, AppState>, id: String, note: String) -> Result<bool, String> {
    let ok = {
        let mut store = state.store.lock().unwrap();
        store.set_note(&id, &note)
    };
    if !ok {
        return Ok(false);
    }
    commit(&app, &state);
    Ok(true)
}

#[tauri::command]
async fn note_begin_edit(app: AppHandle, state: State<'_, AppState>, id: Option<String>) -> Result<bool, String> {
    if panel_window(&app).is_none() {
        return Ok(false);
    }
    let ok = state
        .modes_exec
        .exec(move |m, h| m.begin_note_edit(h, id.as_deref()))
        .await
        .unwrap_or(false);
    Ok(ok)
}

#[tauri::command]
async fn note_end_edit(_app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    let _ = state.modes_exec.exec(|m, h| m.end_note_edit(h, true)).await;
    Ok(true)
}

// 更换快捷键：渲染进程按下组合键后请求注册
#[tauri::command]
async fn shortcut_try(app: AppHandle, state: State<'_, AppState>, accel: String) -> Result<ShortcutTryResult, String> {
    let formatted = format_shortcut(&accel);
    let accel_for_job = accel.clone();
    let ok = state
        .modes_exec
        .exec(move |m, h| m.try_set_toggle_shortcut(h, &accel_for_job))
        .await
        .unwrap_or(false);
    if !ok {
        return Ok(ShortcutTryResult { ok: false, formatted });
    }
    // 成功：保存设置并更新托盘菜单
    {
        let mut settings = state.settings.lock().unwrap();
        settings.shortcut = accel;
        save_settings(&state, &settings);
    }
    rebuild_tray_menu(&app);
    println!("全局快捷键已更换为: {formatted}");
    // 恢复焦点给原程序（导航键恢复已由模式状态机完成）
    let _ = state.modes_exec.exec(|m, h| m.restore_original_focus(h)).await;
    Ok(ShortcutTryResult { ok: true, formatted })
}

#[tauri::command]
async fn shortcut_cancel(_app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    let _ = state.modes_exec.exec(|m, h| m.cancel_shortcut_capture(h, true)).await;
    Ok(true)
}

// 搜索：渲染层点击常驻搜索框时进入搜索模式（与按空格等效）
#[tauri::command]
async fn search_activate(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    if panel_window(&app).is_none() {
        return Ok(true);
    }
    let _ = state.modes_exec.exec(|m, h| m.begin_search(h)).await;
    Ok(true)
}

// 搜索：中文输入法组合中暂停面板导航键（↑↓/Enter 让给 IME 候选），组合结束恢复
#[tauri::command]
async fn search_set_composing(_app: AppHandle, state: State<'_, AppState>, composing: bool) -> Result<bool, String> {
    let _ = state.modes_exec.exec(move |m, h| m.set_composing(h, composing)).await;
    Ok(true)
}

#[tauri::command]
async fn window_hide(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    diag_log("window_hide command");
    let app2 = app.clone();
    let _ = state.modes_exec.exec(move |m, h| hide_panel_on(&app2, m, h, true)).await;
    Ok(true)
}

// 透明窗口点击穿透：圆角外区域应穿透到下层窗口（Windows 实现：切换 WS_EX_TRANSPARENT）
#[tauri::command]
async fn window_set_ignore_mouse(app: AppHandle, ignore: bool, forward: Option<bool>) -> Result<bool, String> {
    let _ = forward; // forward 仅 macOS 有意义
    let Some(win) = panel_window(&app) else { return Ok(false) };
    let Ok(hwnd) = win.hwnd() else { return Ok(false) };
    let hwnd_raw = hwnd.0 as isize; // HWND 含裸指针非 Send，取值后主线程重建
    // 样式切换必须发生在主线程（跨线程改窗口样式同样是同步消息）
    let _ = app.run_on_main_thread(move || unsafe {
        let hwnd = HWND(hwnd_raw as *mut _);
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        let new_style = if ignore {
            style | WS_EX_TRANSPARENT.0
        } else {
            style & !WS_EX_TRANSPARENT.0
        };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_style as isize);
    });
    Ok(true)
}

// ---------- 应用入口 ----------

fn main() {
    // release 构建是 GUI 子系统，panic 默认不可见：落到数据目录的 panic.log（每次崩溃可追溯）
    std::panic::set_hook(Box::new(|info| {
        let thread = std::thread::current();
        let msg = format!(
            "[{:?}] thread={:?} panic: {info}\n{info:?}\n",
            std::time::SystemTime::now(),
            thread.name().unwrap_or("<unnamed>"),
        );
        eprint!("{msg}");
        let dir = data_dir();
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) =
            std::fs::OpenOptions::new().create(true).append(true).open(dir.join("panic.log"))
        {
            use std::io::Write;
            let _ = f.write_all(msg.as_bytes());
        }
    }));

    // ---------- 提权自检与静默拉起（策略见 startup module） ----------
    // release 清单已保证提权；这里只兜住「以非提权方式启动且静默通道已存在」这一种情况。
    if startup::relaunch_if_not_elevated() {
        std::process::exit(0);
    }
    if let Some(line) = startup::status_line() {
        eprintln!("{line}");
    }

    tauri::Builder::default()
        .plugin(
            // 单实例：第二次启动 → 呼出面板（与 Electron second-instance 一致）。必须最先注册。
            tauri_plugin_single_instance::Builder::new()
                .callback(|app, _args, _cwd| {
                    let state = app.state::<AppState>();
                    let app2 = app.clone();
                    state
                        .modes_exec
                        .exec_now(move |modes, host| show_panel_on(&app2, modes, host, true));
                })
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new().with_handler(|app, shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    let state = app.state::<AppState>();
                    let accel = state.hotkeys.lock().unwrap().get(shortcut).cloned();
                    if let Some(accel) = accel {
                        dispatch_hotkey(app, &accel);
                    }
                }
            }).build(),
        )
        .setup(|app| {
            let data_dir = data_dir();
            let _ = std::fs::create_dir_all(data_dir.join("images"));

            // 图片 URL 缓存经 Arc 注入 store 的 remove_image_file 端口（删除/裁剪时同步失效）
            let image_url_cache: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));
            let cache_for_remove = image_url_cache.clone();
            let images_dir_for_save = data_dir.join("images");

            let mut store: HistoryStore = HistoryStoreBuilder::new()
                .save_image_png(Arc::new(move |png: &[u8], id: &str| {
                    let path = images_dir_for_save.join(format!("{id}.png"));
                    match std::fs::write(&path, png) {
                        Ok(()) => Some(path.to_string_lossy().to_string()),
                        Err(err) => {
                            eprintln!("Failed to save clipboard image: {err}");
                            None
                        }
                    }
                }))
                .hash_image_file(Arc::new(|path: &str| {
                    std::fs::read(path)
                        .map(|bytes| history::sha1_hex(&bytes))
                        .unwrap_or_default()
                }))
                .remove_image_file(Arc::new(move |path: &str| {
                    cache_for_remove.lock().unwrap().remove(path);
                    let _ = std::fs::remove_file(path);
                }))
                .image_file_exists(Arc::new(|path: &str| Path::new(path).exists()))
                .build();

            // 载入历史（宽松处理：单条损坏只丢该条）
            let mut icon_cache: HashMap<String, Option<String>> = HashMap::new();
            {
                let raw = std::fs::read_to_string(data_dir.join("clipboard-history.json"))
                    .ok()
                    .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
                    .and_then(|v| v.as_array().cloned());
                store.load(raw);
                // 预热图标缓存：从历史中已有的 sourceApp 恢复，避免重复提取
                for e in store.entries() {
                    if let Some(sa) = &e.source_app {
                        if !sa.exe_path.is_empty() && sa.icon_data_url.is_some() {
                            icon_cache.insert(sa.exe_path.clone(), sa.icon_data_url.clone());
                        }
                    }
                }
            }
            let settings = settings::load(&data_dir.join("settings.json"));

            let (modes_exec, modes_rx) = ModesExecutor::new(app.handle());
            app.manage(AppState {
                store: Mutex::new(store),
                modes_exec,
                modes_visible: AtomicBool::new(false),
                modes_input_active: AtomicBool::new(false),
                settings: Mutex::new(settings),
                icon_cache: Mutex::new(icon_cache),
                image_url_cache,
                last_text: Mutex::new(String::new()),
                last_image_hash: Mutex::new(String::new()),
                last_seq: Mutex::new(0),
                poll_retry: AtomicBool::new(false),
                hotkeys: Mutex::new(HashMap::new()),
                data_dir,
                tray_icon_key: Mutex::new(String::new()),
            });
            // 状态就绪后再启动执行线程（任务里会读 AppState 刷新快照）
            ModesExecutor::spawn_worker(app.handle().clone(), modes_rx);

            let state = app.state::<AppState>();

            // ready-to-show 热身：先在 (0,0) 显示一次让 WebView 完成首帧渲染，120ms 后移到屏外，
            // 避免首次呼出时内容空白闪烁（与 main.js 的 ready-to-show 舞步一致）
            if let Some(win) = panel_window(app.handle()) {
                let _ = win.set_position(Position::Logical(LogicalPosition::new(0.0, 0.0)));
                let _ = win.show();
                let app2 = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(120));
                    move_panel_offscreen(&app2);
                });
            }

            create_tray(app.handle())?;

            // 全局点击监听（点击面板外关闭面板）
            let app2 = app.handle().clone();
            let watcher = click_watcher::ClickWatcher::start(move |x, y| {
                handle_global_click(&app2, x, y);
            });
            app.manage(Mutex::new(watcher));

            // 呼出快捷键也归模式状态机的差量注册管理（捕获/恢复都由它推导）
            {
                let shortcut = state.settings.lock().unwrap().shortcut.clone();
                state.modes_exec.exec_now(move |modes, host| {
                    modes.set_toggle_shortcut(&shortcut, host);
                });
            }

            // 计划任务按持久化意图重建（dev / 未提权时的取舍由 startup 判定）
            {
                let app2 = app.handle().clone();
                std::thread::spawn(move || apply_startup_intent(&app2));
            }

            // 初始基线 + 首次广播
            {
                sync_baseline(&state);
                broadcast(app.handle(), &state);
            }

            // 剪贴板轮询
            {
                let app2 = app.handle().clone();
                std::thread::spawn(move || poll_loop(app2));
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != PANEL_LABEL {
                return;
            }
            let app = window.app_handle();
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // 面板窗口只隐藏不关闭，应用常驻托盘
                    api.prevent_close();
                    let state = app.state::<AppState>();
                    let app2 = app.clone();
                    state
                        .modes_exec
                        .exec_now(move |modes, host| hide_panel_on(&app2, modes, host, true));
                }
                // 浏览态自动失焦：focusable:true 下点击会激活窗口，浏览态下立即 blur 将焦点还回
                // 原程序，输入态（搜索/备注编辑/快捷键捕获）则保留焦点以便输入。
                // 只读无锁原子快照——主线程绝不允许阻塞在模式状态上（死锁防线）。
                tauri::WindowEvent::Focused(true) => {
                    diag_log("focused(true) -> queue auto-blur check");
                    let app2 = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        let state = app2.state::<AppState>();
                        if !state.modes_visible.load(Ordering::Relaxed)
                            || state.modes_input_active.load(Ordering::Relaxed)
                        {
                            return;
                        }
                        let Some(win) = panel_window(&app2) else { return };
                        if !win.is_focused().unwrap_or(false) {
                            return;
                        }
                        unsafe {
                            let _ = SetFocus(None);
                        }
                    });
                }
                tauri::WindowEvent::ThemeChanged(_) => {
                    update_tray_icon(app);
                }
                tauri::WindowEvent::ScaleFactorChanged { .. } => {
                    // 修改缩放比或拖到不同 DPI 显示器时 SM_CXSMICON 随之变化，重选对应物理尺寸
                    update_tray_icon(app);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            clipboard_get,
            clipboard_copy,
            clipboard_remove,
            clipboard_pin,
            clipboard_clear,
            note_set,
            note_begin_edit,
            note_end_edit,
            shortcut_try,
            shortcut_cancel,
            search_activate,
            search_set_composing,
            window_hide,
            window_set_ignore_mouse,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
