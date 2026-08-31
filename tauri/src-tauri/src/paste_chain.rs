// 复制并粘贴链路的唯一归属：五步顺序与结果文案。
//
// 为什么需要这条 seam：Electron 版靠 scripts/focus-paste-regression.js 整模块回归守住
// 「取内容 → 写剪贴板 → 落位 → 恢复焦点 → 注入 Ctrl+V → 隐藏面板」这条链，该脚本随
// Electron 一起删除后目前无等价物。顺序错一步就是「粘贴进错误窗口」或「列表闪一下」
// 这类只有真机才暴露的缺陷。现在链路本身不碰 arboard / Win32 / tauri：效果全部经
// PastePort 注入，生产 adapter 用真实现（main.rs），测试 adapter 记录调用顺序
// （本 module 底部），顺序与文案第一次变成可断言的东西。
//
// 顺序契约（测试逐条断言，改动前先看它们）：
//   content_of → write_clipboard → settle_after_copy → focus_target
//     → restore_and_paste → hide_after_paste（仅粘贴成功时）
// 两条容易写反的次序：
//   - 落位（提升 + 广播 + 同步基线）在注入之前：粘贴失败时列表仍要反映这次复制，
//     因为内容确实已经进了剪贴板；
//   - 隐藏面板在注入成功之后，且隐藏时不再重复恢复焦点（焦点已由粘贴链路归还）。
// 失败文案与 panel:focus-error 事件同源：两处都只经本 module 的 focus_error_message。

use crate::focus_paste::RestoreFailure;
use crate::panel_modes::FocusTarget;
use serde::Serialize;
use std::future::Future;

/// 链路要写进剪贴板的内容：文字直接写，图片按 PNG 文件路径写位图。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CopyContent {
    Text(String),
    Image(String),
}

/// 链路结果。三个入口（键盘 Enter / 双击 / 复制按钮）共用同一个契约 { ok, message }，
/// 渲染层按契约渲染提示，不再各自拼文案。
#[derive(Debug, Clone, Serialize)]
pub struct CopyResult {
    pub ok: bool,
    pub message: &'static str,
}

/// 条目取不到 / 图片文件已丢失 / 剪贴板被其它程序占住，三种情况共用这一句：
/// 用户视角都是「这次复制没发生」。
const ENTRY_UNAVAILABLE: &str = "条目不存在或内容已不可用。";

/// 焦点恢复与粘贴注入的失败文案（唯一映射处，panel:focus-error 事件同源）。
pub(crate) fn focus_error_message(stage: &str) -> &'static str {
    if stage == "paste" {
        "复制已写入剪贴板，但无法粘贴回原输入框，请重试。"
    } else {
        "无法恢复原输入框，已取消本次粘贴，避免写入错误窗口。"
    }
}

/// 链路的全部外部效果。生产实现见 main.rs（真 arboard / Win32 / 模式执行线程），
/// 测试实现见本 module 底部（记录顺序、返回脚本化结果）。
pub trait PastePort {
    /// 1) 取条目内容；条目不存在或图片文件路径缺失 → None
    fn content_of(&mut self, id: &str) -> Option<CopyContent>;
    /// 2) 写剪贴板
    fn write_clipboard(&mut self, content: &CopyContent) -> bool;
    /// 3) 复制后的落位：提升到最近使用 + 落盘广播 + 同步轮询基线
    fn settle_after_copy(&mut self, id: &str);
    /// 4) 取本次呼出捕获的焦点快照（投递模式执行线程）
    fn focus_target(&mut self) -> impl Future<Output = Option<FocusTarget>> + Send;
    /// 5) 恢复原窗口焦点并注入 Ctrl+V
    fn restore_and_paste(&mut self, target: &FocusTarget) -> Result<(), RestoreFailure>;
    /// 6) 粘贴成功后隐藏面板（焦点已归还，不再重复恢复）
    fn hide_after_paste(&mut self) -> impl Future<Output = ()> + Send;
    /// 失败回报渲染层（panel:focus-error）；文案由 focus_error_message 给出
    fn report_focus_error(&mut self, stage: &str, reason: &str);
}

/// 跑完整条链路。任一步失败即中止，返回给渲染层的文案与已发出的事件同源。
pub async fn run<P: PastePort + Send>(port: &mut P, id: &str) -> CopyResult {
    crate::diag_log(&format!("copy: invoked id={id}"));

    let Some(content) = port.content_of(id) else {
        return CopyResult { ok: false, message: ENTRY_UNAVAILABLE };
    };

    let write_ok = port.write_clipboard(&content);
    crate::diag_log(&format!("copy: clipboard write_ok={write_ok}"));
    if !write_ok {
        return CopyResult { ok: false, message: ENTRY_UNAVAILABLE };
    }

    port.settle_after_copy(id);

    let Some(target) = port.focus_target().await else {
        crate::diag_log("copy: no focus target -> abort paste");
        port.report_focus_error("restore", "no_focus_target");
        return CopyResult { ok: false, message: focus_error_message("restore") };
    };

    crate::diag_log("copy: restore+paste begin");
    match port.restore_and_paste(&target) {
        Ok(()) => {
            crate::diag_log("copy: pasted ok -> hide");
            port.hide_after_paste().await;
            CopyResult { ok: true, message: "已复制并粘贴" }
        }
        Err(failure) => {
            crate::diag_log(&format!(
                "copy: restore failed stage={} reason={}",
                failure.stage, failure.reason
            ));
            port.report_focus_error(failure.stage, failure.reason);
            CopyResult { ok: false, message: focus_error_message(failure.stage) }
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)] // 测试名用中文描述规则，snake_case 检查不适用

    use super::*;
    use std::future::Future;
    use std::pin::Pin;
    use std::task::{Context, Poll, Waker};

    /// 测试用极简执行器：假 adapter 的 future 全部立即就绪，不需要 runtime。
    fn block_on<F: Future>(fut: F) -> F::Output {
        let waker = Waker::noop();
        let mut cx = Context::from_waker(waker);
        let mut fut = fut;
        let mut fut = unsafe { Pin::new_unchecked(&mut fut) };
        loop {
            match fut.as_mut().poll(&mut cx) {
                Poll::Ready(v) => return v,
                Poll::Pending => std::thread::yield_now(),
            }
        }
    }

    fn target() -> FocusTarget {
        FocusTarget { hwnd: 1, focus_hwnd: 2, pid: 3, tid: 4 }
    }

    /// 假 adapter：记录调用顺序与脚本化结果，不碰 arboard / Win32 / tauri。
    struct FakePort {
        log: Vec<String>,
        content: Option<CopyContent>,
        write_ok: bool,
        snapshot: Option<FocusTarget>,
        paste: Result<(), RestoreFailure>,
        /// 发出的 panel:focus-error（stage, reason），用于验证文案与事件同源
        errors: Vec<(String, String)>,
    }

    impl FakePort {
        fn text_entry() -> Self {
            FakePort {
                log: Vec::new(),
                content: Some(CopyContent::Text("你好".to_string())),
                write_ok: true,
                snapshot: Some(target()),
                paste: Ok(()),
                errors: Vec::new(),
            }
        }

        fn steps(&self) -> Vec<String> {
            self.log.clone()
        }
    }

    impl PastePort for FakePort {
        fn content_of(&mut self, id: &str) -> Option<CopyContent> {
            self.log.push(format!("content_of({id})"));
            self.content.clone()
        }
        fn write_clipboard(&mut self, content: &CopyContent) -> bool {
            self.log.push(match content {
                CopyContent::Text(_) => "write_clipboard(text)".to_string(),
                CopyContent::Image(_) => "write_clipboard(image)".to_string(),
            });
            self.write_ok
        }
        fn settle_after_copy(&mut self, id: &str) {
            self.log.push(format!("settle_after_copy({id})"));
        }
        fn focus_target(&mut self) -> impl Future<Output = Option<FocusTarget>> + Send {
            self.log.push("focus_target".to_string());
            let snapshot = self.snapshot.clone();
            async move { snapshot }
        }
        fn restore_and_paste(&mut self, _target: &FocusTarget) -> Result<(), RestoreFailure> {
            self.log.push("restore_and_paste".to_string());
            self.paste
        }
        fn hide_after_paste(&mut self) -> impl Future<Output = ()> + Send {
            self.log.push("hide_after_paste".to_string());
            async {}
        }
        fn report_focus_error(&mut self, stage: &str, reason: &str) {
            self.log.push(format!("report_focus_error({stage})"));
            self.errors.push((stage.to_string(), reason.to_string()));
        }
    }

    #[test]
    fn 成功链路_按五步顺序执行并隐藏面板() {
        let mut port = FakePort::text_entry();
        let out = block_on(run(&mut port, "abc"));
        assert!(out.ok);
        assert_eq!(out.message, "已复制并粘贴");
        assert_eq!(
            port.steps(),
            vec![
                "content_of(abc)",
                "write_clipboard(text)",
                "settle_after_copy(abc)",
                "focus_target",
                "restore_and_paste",
                "hide_after_paste",
            ]
        );
        assert!(port.errors.is_empty());
    }

    #[test]
    fn 图片条目_按文件路径写剪贴板() {
        let mut port = FakePort::text_entry();
        port.content = Some(CopyContent::Image("C:/tmp/a.png".to_string()));
        let out = block_on(run(&mut port, "img"));
        assert!(out.ok);
        assert_eq!(port.steps()[1], "write_clipboard(image)");
    }

    #[test]
    fn 条目取不到_不写剪贴板也不碰焦点() {
        let mut port = FakePort::text_entry();
        port.content = None;
        let out = block_on(run(&mut port, "gone"));
        assert!(!out.ok);
        assert_eq!(out.message, "条目不存在或内容已不可用。");
        assert_eq!(port.steps(), vec!["content_of(gone)"]);
    }

    #[test]
    fn 写剪贴板失败_不落位不粘贴() {
        let mut port = FakePort::text_entry();
        port.write_ok = false;
        let out = block_on(run(&mut port, "abc"));
        assert!(!out.ok);
        assert_eq!(out.message, "条目不存在或内容已不可用。");
        assert_eq!(port.steps(), vec!["content_of(abc)", "write_clipboard(text)"]);
    }

    #[test]
    fn 落位先于注入_粘贴失败列表仍反映这次复制() {
        let mut port = FakePort::text_entry();
        port.paste = Err(RestoreFailure { stage: "restore", reason: "restore_failed" });
        let out = block_on(run(&mut port, "abc"));
        assert!(!out.ok);
        let steps = port.steps();
        let settle = steps.iter().position(|s| s == "settle_after_copy(abc)").unwrap();
        let paste = steps.iter().position(|s| s == "restore_and_paste").unwrap();
        assert!(settle < paste, "落位必须在注入之前：{steps:?}");
    }

    #[test]
    fn 无焦点快照_中止注入且不隐藏面板() {
        let mut port = FakePort::text_entry();
        port.snapshot = None;
        let out = block_on(run(&mut port, "abc"));
        assert!(!out.ok);
        assert_eq!(out.message, "无法恢复原输入框，已取消本次粘贴，避免写入错误窗口。");
        assert_eq!(
            port.steps(),
            vec![
                "content_of(abc)",
                "write_clipboard(text)",
                "settle_after_copy(abc)",
                "focus_target",
                "report_focus_error(restore)",
            ]
        );
        assert_eq!(port.errors, vec![("restore".to_string(), "no_focus_target".to_string())]);
    }

    #[test]
    fn 恢复焦点失败_文案按restore_不隐藏面板() {
        let mut port = FakePort::text_entry();
        port.paste = Err(RestoreFailure { stage: "restore", reason: "restore_failed" });
        let out = block_on(run(&mut port, "abc"));
        assert!(!out.ok);
        assert_eq!(out.message, "无法恢复原输入框，已取消本次粘贴，避免写入错误窗口。");
        assert!(!port.steps().contains(&"hide_after_paste".to_string()));
        assert_eq!(port.errors, vec![("restore".to_string(), "restore_failed".to_string())]);
    }

    #[test]
    fn 注入失败_文案按paste_内容已在剪贴板() {
        let mut port = FakePort::text_entry();
        port.paste = Err(RestoreFailure { stage: "paste", reason: "paste_send_failed" });
        let out = block_on(run(&mut port, "abc"));
        assert!(!out.ok);
        assert_eq!(out.message, "复制已写入剪贴板，但无法粘贴回原输入框，请重试。");
        assert!(!port.steps().contains(&"hide_after_paste".to_string()));
        assert_eq!(port.errors, vec![("paste".to_string(), "paste_send_failed".to_string())]);
    }

    /// 同源约束：CopyResult.message 必须等于 panel:focus-error 里那个 stage 的文案，
    /// 两处只经 focus_error_message 这一个函数。
    #[test]
    fn 失败文案与面板事件同源() {
        for stage in ["restore", "paste"] {
            let mut port = FakePort::text_entry();
            port.paste = Err(RestoreFailure { stage, reason: "x" });
            let out = block_on(run(&mut port, "abc"));
            let (event_stage, _) = &port.errors[0];
            assert_eq!(event_stage, stage);
            assert_eq!(out.message, focus_error_message(event_stage));
        }
    }
}
