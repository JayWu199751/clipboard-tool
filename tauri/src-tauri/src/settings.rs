// 设置存档 settings.json：读写与键名契约的唯一归属。
//
// 键名契约（踩坑手册第 5 条，此处翻过一次车）：数据目录与已删除的 Electron 版共享，
// 存档约定是 camelCase（autoStart）；serde 默认按 snake_case 写出 auto_start，
// 重载时找不到键便静默回退默认值，表现为「开机启动打开 → 重启 → 变回关闭」。
// 因此这里显式 rename_all = camelCase，并保留 alias = "auto_start" 兼容误写的旧档，
// 由下面的往返测试把契约钉死。

use serde::{Deserialize, Serialize};
use std::path::Path;

pub const DEFAULT_SHORTCUT: &str = "Control+Shift+V";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default, alias = "auto_start")]
    pub auto_start: bool,
    #[serde(default)]
    pub shortcut: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { auto_start: false, shortcut: DEFAULT_SHORTCUT.to_string() }
    }
}

/// 解析存档文本：serde 优先；整档解析失败时手缝吸收已知键（容忍手写坏字段）。
/// 任何情况下都不报错，坏档退化为默认设置。
pub fn parse(text: &str) -> Settings {
    normalize(match serde_json::from_str::<Settings>(text) {
        Ok(parsed) => parsed,
        Err(_) => {
            let mut fallback = Settings::default();
            if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(text) {
                // 取第一个真正是布尔的键：camelCase 优先，误写的 snake_case 兜底
                let auto_start = ["autoStart", "auto_start"]
                    .iter()
                    .find_map(|key| map.get(*key).and_then(|v| v.as_bool()));
                if let Some(b) = auto_start {
                    fallback.auto_start = b;
                }
                if let Some(s) = map.get("shortcut").and_then(|v| v.as_str()) {
                    fallback.shortcut = s.to_string();
                }
            }
            fallback
        }
    })
}

fn normalize(mut settings: Settings) -> Settings {
    if settings.shortcut.is_empty() {
        settings.shortcut = DEFAULT_SHORTCUT.to_string();
    }
    settings
}

pub fn load(path: &Path) -> Settings {
    std::fs::read_to_string(path)
        .map(|text| parse(&text))
        .unwrap_or_default()
}

pub fn save(path: &Path, settings: &Settings) -> Result<(), String> {
    let json = serde_json::to_string(settings).map_err(|err| err.to_string())?;
    std::fs::write(path, json).map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 写出使用camel_case键名() {
        let json = serde_json::to_string(&Settings { auto_start: true, shortcut: "Ctrl+Alt+V".into() }).unwrap();
        assert!(json.contains("\"autoStart\":true"), "{json}");
        assert!(!json.contains("auto_start"), "{json}");
        assert!(json.contains("\"shortcut\":\"Ctrl+Alt+V\""), "{json}");
    }

    #[test]
    fn 往返序列化保持意图与快捷键() {
        let dir = std::env::temp_dir().join(format!("clipsettings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let original = Settings { auto_start: true, shortcut: "Ctrl+Alt+V".into() };
        save(&path, &original).unwrap();
        assert_eq!(load(&path), original);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 兼容误写的snake_case旧档() {
        let s = parse(r#"{"auto_start":true,"shortcut":"Ctrl+Alt+V"}"#);
        assert!(s.auto_start);
        assert_eq!(s.shortcut, "Ctrl+Alt+V");
    }

    #[test]
    fn 旧字段与未知键忽略_缺省回落默认值() {
        let s = parse(r#"{"autoStart":true,"elevatedPaste":true,"helperToken":"x"}"#);
        assert!(s.auto_start);
        assert_eq!(s.shortcut, DEFAULT_SHORTCUT);
    }

    #[test]
    fn 键值类型错乱时手缝吸收其余已知键() {
        // autoStart 写坏成字符串会让整档 serde 失败，此时仍要保住 shortcut 与合法的 auto_start
        let s = parse(r#"{"autoStart":"yes","auto_start":true,"shortcut":"Ctrl+Alt+B"}"#);
        assert!(s.auto_start);
        assert_eq!(s.shortcut, "Ctrl+Alt+B");
    }

    #[test]
    fn 空快捷键归一为默认快捷键() {
        assert_eq!(parse(r#"{"shortcut":""}"#).shortcut, DEFAULT_SHORTCUT);
        assert_eq!(parse("not json at all").shortcut, DEFAULT_SHORTCUT);
        assert!(!parse("not json at all").auto_start);
    }
}
