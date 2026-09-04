// ClipboardTool（Tauri 重写）主进程编排。
// 本文件只做效果编排：把各 module 的决策接起来跑。规则本身都不在这里：
//   history        条目身份 / 去重提升 / 置顶块 / 裁剪豁免
//   panel_modes    面板四态状态机 + 全局热键差量注册（纯逻辑）
//   modes          状态机的唯一入口：独占执行线程、具名操作、效果宿主
//   panel_window   面板几何 / 焦点 / 鼠标穿透（主线程投递与 DIP 换算都在其内部）
//   poll_baseline  「算不算一次新复制」的基线判定
//   startup        静默启动通道的意图 / 事实分离
//   settings       settings.json 键名契约
//   paste_chain    复制并粘贴链路的五步顺序与结果文案
// 剩下的编排职责：剪贴板读写、持久化与广播、托盘、全局热键分发、IPC 命令。
//
// 结构要点：
// - 焦点快照、来源应用图标、全局点击监听、计划任务拉起全部住在本进程内
//   （focus_paste / source_app / click_watcher / tasks），没有外部助手进程。
// - 面板模式状态机（panel_modes）经 modes::ModesHost 注入效果；焦点快照是同步 Win32 调用。
// - 数据目录固定在 %APPDATA%\ClipboardTool，历史 JSON 与图片文件都落在里面，
//   键名契约见 ADR-0007。
//
// 线程模型（死锁防线的核心，改动前必读）：见 modes module 顶部注释。
// 一句话：PanelModes 由 modes::Modes 独占的执行线程持有，本文件只通过 AppState::modes
// 投递具名操作；主线程只读无锁原子快照（modes_visible / modes_input_active），
// 绝不阻塞在模式上。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod click_watcher;
mod focus_paste;
mod history;
mod modes;
mod panel_modes;
mod panel_window;
mod paste_chain;
mod poll_baseline;
mod source_app;
mod settings;
mod startup;
mod tasks;

use history::{EntryType, HistoryStore, HistoryStoreBuilder, SourceApp};
use settings::Settings;
use modes::Modes;
use panel_modes::{is_repeatable_navigation, FocusTarget};
use panel_window::{PanelWindow, PANEL_LABEL};
use paste_chain::{CopyContent, CopyResult, PastePort};
use poll_baseline::{Change, PollBaseline};
use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, Wry};
use tauri_plugin_global_shortcut::{Shortcut, ShortcutState};
use base64::Engine as _;

const POLL_INTERVAL: Duration = Duration::from_millis(600);
const NAV_REPEAT_INITIAL_DELAY: Duration = Duration::from_millis(300);
const NAV_REPEAT_INTERVAL: Duration = Duration::from_millis(50);
const TRAY_ICON_SIZES: [u32; 5] = [16, 20, 24, 28, 32];
const TRAY_ID: &str = "main-tray";

#[derive(Default)]
struct NavigationRepeat {
    active: Mutex<HashMap<Shortcut, Arc<AtomicBool>>>,
}

impl NavigationRepeat {
    fn start(&self, app: AppHandle, shortcut: Shortcut, accel: String, modes: Modes) {
        if !is_repeatable_navigation(&accel) {
            return;
        }

        let stop = Arc::new(AtomicBool::new(false));
        {
            let mut active = self.active.lock().unwrap();
            if active.contains_key(&shortcut) {
                return;
            }
            active.insert(shortcut, stop.clone());
        }

        std::thread::spawn(move || {
            std::thread::sleep(NAV_REPEAT_INITIAL_DELAY);
            loop {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let state = app.state::<AppState>();
                if !state.modes_visible.load(Ordering::Relaxed) {
                    state.navigation_repeat.stop(&shortcut);
                    break;
                }
                modes.dispatch_accel(&accel);
                std::thread::sleep(NAV_REPEAT_INTERVAL);
            }
        });
    }

    fn stop(&self, shortcut: &Shortcut) {
        if let Some(stop) = self.active.lock().unwrap().remove(shortcut) {
            stop.store(true, Ordering::Relaxed);
        }
    }
}

struct AppState {
    store: Mutex<HistoryStore>,
    // 面板模式状态的唯一入口：内部独占一条执行线程，外部拿不到 &mut PanelModes
    modes: Modes,
    // 主线程使用的无锁快照（执行线程在每次模式操作后刷新）
    modes_visible: AtomicBool,
    modes_input_active: AtomicBool,
    settings: Mutex<Settings>,
    // exePath -> dataUrl（None = 提取失败的负缓存）
    icon_cache: Mutex<HashMap<String, Option<String>>>,
    // imagePath -> dataUrl：broadcast 时读盘+base64 的永久缓存（图片文件创建后内容不变）；
    // Arc 共享给 store 的 remove_image_file 端口（删除/裁剪时同步失效）
    image_url_cache: Arc<Mutex<HashMap<String, String>>>,
    // 「这次剪贴板算不算一次新复制」的基线（序列号短路、图片/文字基线、写盘失败重试）
    baseline: Mutex<PollBaseline>,
    hotkeys: Mutex<HashMap<Shortcut, String>>, // Shortcut -> accel（host 注册的记录，供分发）
    navigation_repeat: NavigationRepeat,
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

// ---------- 数据目录（%APPDATA%\ClipboardTool，存档契约见 ADR-0007） ----------

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

// 面板事件的唯一出口：窗口不存在时静默丢弃
fn emit_panel(app: &AppHandle, event: &str, payload: impl Serialize + Clone) {
    let Some(win) = app.get_webview_window(PANEL_LABEL) else { return };
    let _ = win.emit(event, payload);
}

fn broadcast(app: &AppHandle, state: &AppState) {
    let entries: Vec<RendererEntry> = {
        let store = state.store.lock().unwrap();
        store
            .entries()
            .iter()
            .filter_map(|e| to_renderer_entry(state, e))
            .collect()
    };
    emit_panel(app, "clipboard:updated", entries);
}

// 一次变更 = store 方法 + commit()（persist + broadcast）
fn commit(app: &AppHandle, state: &AppState) {
    persist(state);
    broadcast(app, state);
}

// ---------- 剪贴板效果 ----------

// 读剪贴板图片并编码为 PNG 字节
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
// 否则每 600ms 都要无条件读一次剪贴板图片并编码 PNG。
fn clipboard_seq() -> u32 {
    unsafe { windows::Win32::System::DataExchange::GetClipboardSequenceNumber() }
}

// 读一次剪贴板当前内容，交给基线模块认作「已见过」（启动基线、自己写入后的同步都走这里）
fn sync_baseline(state: &AppState) {
    let Ok(mut clip) = arboard::Clipboard::new() else { return };
    let png = clipboard_read_image_png(&mut clip).filter(|bytes| !bytes.is_empty());
    let text = clip.get_text().unwrap_or_default();
    let mut baseline = state.baseline.lock().unwrap();
    baseline.sync_now(png, text);
    baseline.note_seq(clipboard_seq());
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
    let png = clipboard_read_image_png(&mut clip).filter(|bytes| !bytes.is_empty());
    let text = clip.get_text().unwrap_or_default();

    // 判定在基线模块内：图片优先、按内容哈希/文本比对，暂存待 confirm
    let change = state.baseline.lock().unwrap().observe(png.clone(), text);
    let recorded = match change {
        Some(Change::Image { png, .. }) => {
            poll_trace(&format!("image len={}", png.len()));
            let source_app = current_source_app(state);
            let mut store = state.store.lock().unwrap();
            store.record_image(&png, source_app).entry.is_some()
        }
        Some(Change::Text(text)) => {
            poll_trace(&format!("text len={}", text.len()));
            let source_app = current_source_app(state);
            let mut store = state.store.lock().unwrap();
            store.record_text(&text, source_app).entry.is_some()
        }
        // 无新内容：仍要接受暂存的基线更新（图片未变时文字基线得跟上）
        None => {
            state.baseline.lock().unwrap().confirm(true);
            return;
        }
    };
    // 写盘失败时基线不动并置重试标志，下一轮即使序列号未变也会再试一次
    state.baseline.lock().unwrap().confirm(recorded);
    if recorded {
        commit(app, state);
    }
}

fn poll_loop(app: AppHandle) {
    loop {
        std::thread::sleep(POLL_INTERVAL);
        let state = app.state::<AppState>();
        // 序列号未变且没有待重试的写盘失败 → 本轮无需读剪贴板
        if state.baseline.lock().unwrap().skip_unchanged(clipboard_seq()) {
            continue;
        }
        // 轮询线程要面对任意应用写入的剪贴板内容：单次异常只记录并跳过，不允许杀死轮询
        let app2 = app.clone();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            poll_once(&app2, &state);
        }));
        state.baseline.lock().unwrap().note_seq(clipboard_seq());
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

// 失败回报渲染层：文案唯一映射处在 paste_chain::focus_error_message，
// 与 CopyResult.message 同源（两处都只经那一个函数）。
fn send_focus_error(app: &AppHandle, stage: &str, reason: &str) {
    emit_panel(
        app,
        "panel:focus-error",
        FocusErrorPayload {
            stage: stage.to_string(),
            reason: reason.to_string(),
            message: paste_chain::focus_error_message(stage).to_string(),
        },
    );
}

// ---------- 面板窗口（几何 / 焦点 / 穿透的唯一归属见 panel_window module） ----------

// 窗口几何、焦点、样式变更都必须投递主线程执行：跨线程直接调用会向主线程同步发消息，
// 主线程若正在等我们的锁（热键 / 点击 / 命令路径都持有状态锁）即互等死锁。
// 这条约束现在由 PanelWindow 的实现内部承担，调用方只管动作。
fn panel(app: &AppHandle) -> PanelWindow {
    PanelWindow::new(app)
}


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

// 托盘图标按主屏缩放取「恰好物理尺寸」的图，取不到缩放时按 1x 处理
fn primary_scale(app: &AppHandle) -> f64 {
    app.primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0)
}

fn update_tray_icon(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let state = app.state::<AppState>();
    let scale = primary_scale(app);
    let dark = panel(app).is_dark_theme();
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
    let Some(icon) = window_icon_image(dark) else { return };
    panel(app).set_icon(icon);
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
    let scale = primary_scale(app);
    let dark = panel(app).is_dark_theme();
    let icon = tray_icon_image(dark, scale).ok_or_else(|| std::io::Error::other("tray icon missing"))?;
    let menu = build_tray_menu(app, &state)?;
    let _tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("剪贴板工具")
        .menu(&menu)
        // 左键点击呼出面板，菜单走右键
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                let state = app.state::<AppState>();
                state.modes.show();
            }
            "change-shortcut" => {
                app.state::<AppState>().modes.begin_shortcut_capture();
            }
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
                state.modes.show();
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

// 复制并粘贴链路的生产 adapter：paste_chain 只管顺序与文案，五个效果在这里落地。
// 焦点快照与隐藏面板要经模式执行线程，故这两个方法是 async 的（链路整体 await）。
struct Win32PastePort<'a> {
    app: &'a AppHandle,
    state: &'a AppState,
}

impl PastePort for Win32PastePort<'_> {
    fn content_of(&mut self, id: &str) -> Option<CopyContent> {
        // store 短暂锁定，不与模式状态交叉
        let store = self.state.store.lock().unwrap();
        let entry = store.find(id)?;
        match entry.entry_type {
            EntryType::Text => Some(CopyContent::Text(entry.text.clone().unwrap_or_default())),
            EntryType::Image => entry.image_path.clone().map(CopyContent::Image),
        }
    }

    fn write_clipboard(&mut self, content: &CopyContent) -> bool {
        match content {
            CopyContent::Text(text) => write_clipboard_text(text),
            CopyContent::Image(path) => write_clipboard_image_file(path),
        }
    }

    fn settle_after_copy(&mut self, id: &str) {
        // 复制后的落位与去重提升是同一规则（置顶刷新 pinnedAt 移块首；普通移普通块最前）
        self.state.store.lock().unwrap().promote(id);
        commit(self.app, self.state);
        // 同步轮询基线：刚写进剪贴板的内容不应在下一个 600ms 轮询里被当成"新复制"
        // 再次提升+广播（一次多余的全列表重绘，也是粘贴后闪烁的来源）
        sync_baseline(self.state);
    }

    fn focus_target(&mut self) -> impl Future<Output = Option<FocusTarget>> + Send {
        let reply = self.state.modes.focus_target();
        async move { reply.await.unwrap_or(None) }
    }

    fn restore_and_paste(&mut self, target: &FocusTarget) -> Result<(), focus_paste::RestoreFailure> {
        focus_paste::restore_and_paste(target, true)
    }

    fn hide_after_paste(&mut self) -> impl Future<Output = ()> + Send {
        // 粘贴已把焦点归还原窗口，隐藏时不再重复恢复
        let reply = self.state.modes.hide_after_paste();
        async move { let _ = reply.await; }
    }

    fn report_focus_error(&mut self, stage: &str, reason: &str) {
        send_focus_error(self.app, stage, reason);
    }
}

#[tauri::command]
fn clipboard_get(state: State<AppState>) -> Vec<RendererEntry> {
    let store = state.store.lock().unwrap();
    store.entries().iter().filter_map(|e| to_renderer_entry(&state, e)).collect()
}

#[tauri::command]
async fn clipboard_copy(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<CopyResult, String> {
    Ok(paste_chain::run(&mut Win32PastePort { app: &app, state: &state }, &id).await)
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
    if !panel(&app).exists() {
        return Ok(false);
    }
    let ok = state
        .modes
        .begin_note_edit(id)
        .await
        .unwrap_or(false);
    Ok(ok)
}

#[tauri::command]
async fn note_end_edit(_app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    let _ = state.modes.end_note_edit().await;
    Ok(true)
}

// 更换快捷键：渲染进程按下组合键后请求注册
#[tauri::command]
async fn shortcut_try(app: AppHandle, state: State<'_, AppState>, accel: String) -> Result<ShortcutTryResult, String> {
    let formatted = format_shortcut(&accel);
    let ok = state.modes.try_set_toggle_shortcut(&accel).await.unwrap_or(false);
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
    let _ = state.modes.restore_original_focus().await;
    Ok(ShortcutTryResult { ok: true, formatted })
}

#[tauri::command]
async fn shortcut_cancel(_app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    let _ = state.modes.cancel_shortcut_capture().await;
    Ok(true)
}

// 搜索：渲染层点击常驻搜索框时进入搜索模式（与按空格等效）
#[tauri::command]
async fn search_activate(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    if !panel(&app).exists() {
        return Ok(true);
    }
    let _ = state.modes.begin_search().await;
    Ok(true)
}

// 搜索：中文输入法组合中暂停面板导航键（↑↓/Enter 让给 IME 候选），组合结束恢复
#[tauri::command]
async fn search_set_composing(_app: AppHandle, state: State<'_, AppState>, composing: bool) -> Result<bool, String> {
    let _ = state.modes.set_composing(composing).await;
    Ok(true)
}

#[tauri::command]
async fn window_hide(_app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    diag_log("window_hide command");
    let _ = state.modes.hide().await;
    Ok(true)
}

// 透明窗口点击穿透：圆角外区域应穿透到下层窗口（Windows 实现在 PanelWindow 内）
#[tauri::command]
async fn window_set_ignore_mouse(app: AppHandle, ignore: bool, forward: Option<bool>) -> Result<bool, String> {
    let _ = forward; // forward 仅 macOS 有意义
    let panel = panel(&app);
    if !panel.exists() {
        return Ok(false);
    }
    panel.set_mouse_passthrough(ignore);
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
            // 单实例：第二次启动 → 呼出面板。必须最先注册。
            tauri_plugin_single_instance::Builder::new()
                .callback(|app, _args, _cwd| {
                    let state = app.state::<AppState>();
                    state.modes.show();
                })
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new().with_handler(|app, shortcut, event| {
                let state = app.state::<AppState>();
                match event.state() {
                    ShortcutState::Pressed => {
                        let accel = state.hotkeys.lock().unwrap().get(shortcut).cloned();
                        if let Some(accel) = accel {
                            state.modes.dispatch_accel(&accel);
                            state.navigation_repeat.start(
                                app.clone(),
                                *shortcut,
                                accel,
                                state.modes.clone(),
                            );
                        }
                    }
                    ShortcutState::Released => state.navigation_repeat.stop(shortcut),
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

            // 执行线程在这里起来：任务收尾要读 AppState 刷新快照，故先 manage 再 spawn
            app.manage(AppState {
                store: Mutex::new(store),
                modes: Modes::spawn(app.handle()),
                modes_visible: AtomicBool::new(false),
                modes_input_active: AtomicBool::new(false),
                settings: Mutex::new(settings),
                icon_cache: Mutex::new(icon_cache),
                image_url_cache,
                baseline: Mutex::new(PollBaseline::new()),
                hotkeys: Mutex::new(HashMap::new()),
                navigation_repeat: NavigationRepeat::default(),
                data_dir,
                tray_icon_key: Mutex::new(String::new()),
            });
            let state = app.state::<AppState>();

            // ready-to-show 热身：先在 (0,0) 显示一次让 WebView 完成首帧渲染，120ms 后移到屏外，
            // 避免首次呼出时内容空白闪烁（与 main.js 的 ready-to-show 舞步一致）
            let warmup = panel(app.handle());
            if warmup.exists() {
                warmup.set_position(0.0, 0.0);
                warmup.show();
                let app2 = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(120));
                    panel(&app2).park_offscreen();
                });
            }

            create_tray(app.handle())?;

            // 全局点击监听（点击面板外关闭面板）
            let app2 = app.handle().clone();
            let watcher = click_watcher::ClickWatcher::start(move |x, y| {
                app2.state::<AppState>().modes.hide_if_clicked_outside(x, y);
            });
            app.manage(Mutex::new(watcher));

            // 呼出快捷键也归模式状态机的差量注册管理（捕获/恢复都由它推导）
            {
                let shortcut = state.settings.lock().unwrap().shortcut.clone();
                state.modes.set_toggle_shortcut(&shortcut);
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
                    state.modes.hide();
                }
                // 浏览态自动失焦：focusable:true 下点击会激活窗口，浏览态下立即 blur 将焦点还回
                // 原程序，输入态（搜索/备注编辑/快捷键捕获）则保留焦点以便输入。
                // 只读无锁原子快照——主线程绝不允许阻塞在模式状态上（死锁防线）。
                tauri::WindowEvent::Focused(true) => {
                    diag_log("focused(true) -> queue auto-blur check");
                    // 只读无锁原子快照：主线程绝不允许阻塞在模式状态上（死锁防线）。
                    // 归还焦点这个动作本身由 PanelWindow 投递主线程执行。
                    let state = app.state::<AppState>();
                    if state.modes_visible.load(Ordering::Relaxed)
                        && !state.modes_input_active.load(Ordering::Relaxed)
                    {
                        panel(app).release_focus();
                    }
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
