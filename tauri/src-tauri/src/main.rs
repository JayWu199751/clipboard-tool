// ClipboardTool（Tauri 重写）主进程编排。
// 本文件只做效果编排：把各 module 的决策接起来跑。规则本身都不在这里：
//   history        条目身份 / 去重提升 / 置顶块 / 裁剪豁免
//   clipboard      剪贴板独占窗口：打开重试、格式退让、Drop 必关、读写与序列号
//   clipboard_events 剪贴板变化的事件源：建消息窗、注册监听、等通知、失败排重试（起不来则退回轮询）
//   clipboard_probe 真机探针（仅测试构建）：通知能否收到 / 通知到可读的等待 / 一次复制几条通知
//   hotkeys        全局热键记账的唯一真源：accel ↔ Shortcut 双向表、展示文案
//   panel_modes    面板四态状态机 + 「该注册哪些键」的推导（纯逻辑）
//   modes          状态机的唯一入口：独占执行线程、具名操作、效果宿主（热键表与连发登记都在它手上）
//   panel_window   面板几何 / 焦点 / 鼠标穿透（主线程投递与 DIP 换算都在其内部）
//   poll_baseline  「算不算一次新复制」的基线判定
//   dib            剪贴板 DIB 字节 → PNG 的解码判定
//   startup        静默启动通道的意图 / 事实分离
//   settings       settings.json 键名契约
//   paste_chain    复制并粘贴链路的五步顺序与结果文案
//   tray           托盘图标尺寸阶梯、去重键、菜单文案
// 剩下的编排职责：持久化与广播、IPC 命令。热键回调只做「把 Shortcut 投给执行线程」这一件事。
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
mod clipboard;
// 剪贴板变化的事件源：message-only 窗口 + 系统通知 + 阻塞等的消息循环（注册不上时退回轮询）
mod clipboard_events;
// 真机探针（仅测试构建）：量「提权进程能否收到 WM_CLIPBOARDUPDATE / 通知到可读的等待 / 一次复制几条通知」
#[cfg(test)]
mod clipboard_probe;
mod dib;
mod focus_paste;
mod history;
mod hotkeys;
mod modes;
mod panel_modes;
mod panel_window;
mod paste_chain;
mod poll_baseline;
mod source_app;
mod settings;
mod startup;
mod tasks;
mod tray;

use history::{EntryType, HistoryStore, SourceApp};
use settings::Settings;
use modes::Modes;
use panel_modes::FocusTarget;
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
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::ShortcutState;
use base64::Engine as _;
use tray::Tray;

const POLL_INTERVAL: Duration = Duration::from_millis(600);

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
    data_dir: PathBuf,
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

// ---------- 剪贴板基线同步 ----------
// 独占窗口与读写都在 clipboard module（OpenClipboard 重试、CF_DIBV5 → CF_DIB 退让、
// Drop 必关、arboard 读写），这里只留「把当前内容认作已见过」这一步编排。

// 读一次剪贴板当前内容，交给基线模块认作「已见过」（启动基线、自己写入后的同步都走这里）
fn sync_baseline(state: &AppState) {
    let seq = clipboard::sequence();
    let snapshot = match clipboard::read() {
        clipboard::ReadOutcome::Known(snapshot) => snapshot,
        // 启动这一刻剪贴板被占着：不预设基线即可。sync 的用途只是「别把启动时已躺在剪贴板里的
        // 内容当成新复制」，读不到就没什么可预设的；下一次通知会把真实内容照常记进来。
        clipboard::ReadOutcome::Occupied => return,
    };
    let mut baseline = state.baseline.lock().unwrap();
    baseline.sync_now(snapshot.png, snapshot.text);
    baseline.note_seq(seq);
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

// 跑一轮：读一次剪贴板、判定、落库广播。返回 true 表示这一轮已尘埃落定；
// false 表示剪贴板被占用或写盘失败，需要稍后再试一遍（事件路径靠 SetTimer 排重试、
// 兜底路径靠 600ms 心跳）。与 main.js pollClipboard 逐段对齐。
fn poll_round(app: &AppHandle, state: &AppState) -> bool {
    // 记的是**触发这次读取的那个**序列号：若读取期间内容又变了，序列号会前进，下一轮不会被短路
    let seq = clipboard::sequence();
    // 序列号未变且没有欠着的一轮 → 这份通知已经处理过，不必再开剪贴板跟别人抢
    if state.baseline.lock().unwrap().skip_unchanged(seq) {
        return true;
    }
    poll_trace("new");
    // 一次读取（先图后字）由 clipboard 独占剪贴板；图片不走 arboard 的原因见该 module。
    // 「剪贴板被别的程序占着」与「剪贴板里就是没有内容」必须分开：前者这次读取不可信，
    // 当成空内容接受会把这次复制从基线上抹掉、序列号照旧推进，从此被短路吃掉、永久消失。
    let snapshot = match clipboard::read() {
        clipboard::ReadOutcome::Known(snapshot) => snapshot,
        clipboard::ReadOutcome::Occupied => {
            poll_trace("clipboard-occupied");
            state.baseline.lock().unwrap().note_untrusted();
            return false;
        }
    };
    poll_trace("opened");
    let clipboard::Snapshot { png, text } = snapshot;

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
            let mut baseline = state.baseline.lock().unwrap();
            baseline.confirm(true);
            baseline.note_seq(seq);
            return true;
        }
    };
    // 写盘失败时基线不动并置重试标记，稍后即使序列号未变也会再试一次
    let settled = {
        let mut baseline = state.baseline.lock().unwrap();
        baseline.confirm(recorded);
        baseline.note_seq(seq);
        !baseline.retry_pending()
    };
    if recorded {
        commit(app, state);
    }
    settled
}

// 剪贴板监听线程：优先走系统通知（收到才读），事件源起不来时退回 600ms 轮询。
fn clipboard_watch(app: AppHandle) {
    let source = app.clone();
    let result = clipboard_events::run(move || {
        let state = source.state::<AppState>();
        let app2 = source.clone();
        // 监听线程要面对任意应用写入的剪贴板内容：单次异常只记录并跳过，不允许杀死监听
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| poll_round(&app2, &state)))
            // panic 视为「这一轮到此为止」但不排重试——免得同一次异常把重试打成死循环
            .unwrap_or(true)
    });
    if let Err(why) = result {
        eprintln!("剪贴板事件源起不来（{why}），退回 600ms 轮询");
        poll_fallback(app);
    }
}

// 事件源起不来时的兜底：行为与改动前一致（600ms 一拍，序列号短路在 poll_round 内部）。
// 留着它是因为「轮询最坏是慢，事件源最坏是全哑」——多这十几行，最坏情况就只是慢。
fn poll_fallback(app: AppHandle) {
    loop {
        std::thread::sleep(POLL_INTERVAL);
        let state = app.state::<AppState>();
        let app2 = app.clone();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            poll_round(&app2, &state);
        }));
        if let Err(panic) = result {
            let msg = panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "unknown panic".to_string());
            eprintln!("poll_round panicked (skipped this round): {msg}");
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
    Tray::new(app).rebuild_menu();
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
            CopyContent::Text(text) => clipboard::write_text(text),
            CopyContent::Image(path) => clipboard::write_image_file(path),
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
    let formatted = hotkeys::format_shortcut(&accel);
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
    Tray::new(&app).rebuild_menu();
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
            // 回调必须立即返回：这里只把 Shortcut 交给执行线程。「这是哪个动作、要不要
            // 继续连发」全在 hotkeys 那张表上判（表由执行线程独占，主线程不再读它）。
            tauri_plugin_global_shortcut::Builder::new().with_handler(|app, shortcut, event| {
                let state = app.state::<AppState>();
                match event.state() {
                    ShortcutState::Pressed => { state.modes.on_hotkey_pressed(*shortcut); }
                    ShortcutState::Released => { state.modes.on_hotkey_released(*shortcut); }
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

            // 四个文件端口必供（缺一个编译不过），时钟端口取默认（真时钟 + uuid v4）。
            let mut store: HistoryStore = HistoryStore::new(
                history::DEFAULT_MAX_HISTORY,
                history::Ports {
                    save_image_png: Arc::new(move |png: &[u8], id: &str| {
                        let path = images_dir_for_save.join(format!("{id}.png"));
                        match std::fs::write(&path, png) {
                            Ok(()) => Some(path.to_string_lossy().to_string()),
                            Err(err) => {
                                eprintln!("Failed to save clipboard image: {err}");
                                None
                            }
                        }
                    }),
                    hash_image_file: Arc::new(|path: &str| {
                        std::fs::read(path).map(|bytes| history::sha1_hex(&bytes)).unwrap_or_default()
                    }),
                    remove_image_file: Arc::new(move |path: &str| {
                        cache_for_remove.lock().unwrap().remove(path);
                        let _ = std::fs::remove_file(path);
                    }),
                    image_file_exists: Arc::new(|path: &str| Path::new(path).exists()),
                },
                history::Clock::default(),
            );

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
                data_dir,
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

            Tray::new(app.handle()).create()?;

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

            // 剪贴板监听（系统通知优先，起不来时退回 600ms 轮询）
            {
                let app2 = app.handle().clone();
                std::thread::spawn(move || clipboard_watch(app2));
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
                    Tray::new(app).sync_icon();
                }
                tauri::WindowEvent::ScaleFactorChanged { .. } => {
                    // 修改缩放比或拖到不同 DPI 显示器时 SM_CXSMICON 随之变化，重选对应物理尺寸
                    Tray::new(app).sync_icon();
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