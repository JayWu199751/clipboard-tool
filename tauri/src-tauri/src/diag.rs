// 诊断日志的判定侧：日志多大该轮转。写盘这个效果留在 main.rs（ADR-0008）。
//
// 为什么要有「无条件写」这一档（`diag_vital`）：呼出链路的每一段都可能静默失败——
// 任务投不进主线程、执行线程卡住、窗口没落地、渲染层没画出来——而现场只在开机那一次
// 存在，退出重开就全好。2026-09-20 那轮把读数交给了 `CLIPBOARD_TOOL_DIAG=1` 门禁，
// 结果 2026-09-27 开机那次 `diag.log` 一个字都没有：按验证清单把环境变量清掉之后，
// 门是关着的。于是开机关键路径的几行改成无条件写（vital 前缀），逐事件的嘈杂日志
// 仍留在门禁之后。决策与否决项见 ADR-0013。

/// `diag.log` 超过这个字节数就轮转（旧文件挪成 `diag.log.1`）。
/// vital 行是常驻写入，不封顶就是无界增长：一次呼出约 5 行，重度使用一天几百行。
pub const MAX_LOG_BYTES: u64 = 512 * 1024;

/// 判定：这份日志该不该轮转。等于上限不轮转（那时还没超）。
pub fn should_rotate(len: u64) -> bool {
    len > MAX_LOG_BYTES
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)] // 测试名用中文描述规则，snake_case 检查不适用
    use super::*;

    #[test]
    fn 日志超过上限才轮转_等于上限不动() {
        assert!(!should_rotate(0));
        assert!(!should_rotate(MAX_LOG_BYTES), "正好到上限还装得下，轮转是白丢一代现场");
        assert!(should_rotate(MAX_LOG_BYTES + 1));
        assert!(should_rotate(64 * 1024 * 1024));
    }
}
