// 设置存档 settings.json：读写与键名契约的唯一归属。
//
// 键名契约（踩坑手册第 5 条，此处翻过一次车）：老用户手上的存档约定是 camelCase（autoStart），
// 键名一改就是存档破坏；serde 默认按 snake_case 写出 auto_start，
// 重载时找不到键便静默回退默认值，表现为「开机启动打开 → 重启 → 变回关闭」。
// 因此这里显式 rename_all = camelCase，并保留 alias = "auto_start" 兼容误写的旧档，
// 由下面的往返测试把契约钉死。

use serde::{Deserialize, Serialize};
use std::path::Path;

pub const DEFAULT_SHORTCUT: &str = "Control+Shift+V";

/// 主题偏好：三态，术语见 CONTEXT.md「主题偏好」。存档里是小写字面量
/// （`"system"` / `"light"` / `"dark"`），缺键与非法值一律回落 System（跟随系统）：
/// 坏档可以把主题退回默认，但不许把面板钉死在一个看不懂的配色上。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

impl Theme {
    /// 菜单与诊断里的中文名
    pub fn label(self) -> &'static str {
        match self {
            Theme::System => "跟随系统",
            Theme::Light => "亮色",
            Theme::Dark => "暗色",
        }
    }
}

/// 判定：存档文本 → 偏好。只认三个小写字面量，其余回落跟随系统
pub fn parse_theme(raw: &str) -> Theme {
    match raw {
        "light" => Theme::Light,
        "dark" => Theme::Dark,
        _ => Theme::System,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default, alias = "auto_start")]
    pub auto_start: bool,
    #[serde(default)]
    pub shortcut: String,
    #[serde(default)]
    pub theme: Theme,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { auto_start: false, shortcut: DEFAULT_SHORTCUT.to_string(), theme: Theme::default() }
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
                // 主题写坏（拼错、写成布尔）时丢掉它自己，其余键照旧保住
                if let Some(t) = map.get("theme").and_then(|v| v.as_str()) {
                    fallback.theme = parse_theme(t);
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
    #![allow(non_snake_case)] // 测试名用中文描述规则，snake_case 检查不适用
    use super::*;

    #[test]
    fn 写出使用camel_case键名() {
        let json = serde_json::to_string(&Settings {
            auto_start: true,
            shortcut: "Ctrl+Alt+V".into(),
            theme: Theme::Dark,
        })
        .unwrap();
        assert!(json.contains("\"autoStart\":true"), "{json}");
        assert!(!json.contains("auto_start"), "{json}");
        assert!(json.contains("\"shortcut\":\"Ctrl+Alt+V\""), "{json}");
        // 主题写小写字面量：它是给人看的存档，不是 Rust 枚举名的转写
        assert!(json.contains("\"theme\":\"dark\""), "{json}");
    }

    #[test]
    fn 往返序列化保持意图快捷键与主题() {
        let dir = std::env::temp_dir().join(format!("clipsettings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let original = Settings {
            auto_start: true,
            shortcut: "Ctrl+Alt+V".into(),
            theme: Theme::Light,
        };
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
        // 旧档根本没有 theme 键：必须回落跟随系统，而不是随机落在一套皮肤上
        assert_eq!(s.theme, Theme::System);
    }

    #[test]
    fn 主题值非法回落跟随系统() {
        assert_eq!(parse(r#"{"theme":"light"}"#).theme, Theme::Light);
        assert_eq!(parse(r#"{"theme":"dark"}"#).theme, Theme::Dark);
        // 大小写、拼错、写成布尔：认不出来就回默认，且不影响其余键
        assert_eq!(parse(r#"{"theme":"Night"}"#).theme, Theme::System);
        let s = parse(r#"{"theme":"Night","autoStart":true,"shortcut":"Ctrl+Alt+B"}"#);
        assert_eq!(s.theme, Theme::System);
        assert!(s.auto_start);
        assert_eq!(s.shortcut, "Ctrl+Alt+B");
        assert_eq!(parse(r#"{"theme":true}"#).theme, Theme::System);
    }

    #[test]
    fn 手缝分支也认主题键() {
        // theme 本身合法、但 autoStart 写坏成字符串会让整档 serde 失败，走手缝：三条都得保住
        let s = parse(r#"{"theme":"light","autoStart":"yes","auto_start":true,"shortcut":"Ctrl+Alt+B"}"#);
        assert_eq!(s.theme, Theme::Light);
        assert!(s.auto_start);
        assert_eq!(s.shortcut, "Ctrl+Alt+B");
    }

    #[test]
    fn 主题三态标签唯一且非空() {
        let labels = [Theme::System.label(), Theme::Light.label(), Theme::Dark.label()];
        assert!(labels.iter().all(|label| !label.is_empty()));
        assert_eq!(labels.iter().collect::<std::collections::HashSet<_>>().len(), 3);
        assert_eq!(Theme::default(), Theme::System, "默认必须是跟随系统");
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
