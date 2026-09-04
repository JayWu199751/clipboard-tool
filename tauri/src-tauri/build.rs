// 构建脚本：
// - 默认（开发）嵌入 Tauri 默认清单（asInvoker），便于非提权调试。
// - 设 CLIPBOARD_TOOL_ELEVATED=1 时嵌入 requireAdministrator 清单（常驻提权设计，
//   见 ADR-0001）：热键与 SendInput 不被 UIPI 拦截，管理员前台照常工作。
//   打包发布用 `set CLIPBOARD_TOOL_ELEVATED=1` + `tauri build`。
//   注意：清单替换需保留 PerMonitorV2 DPI 感知，否则坐标换算全部失准。
//   关键：必须保留 Common-Controls 6 依赖，否则 comctl32 5.x 没有 TaskDialogIndirect，
//   启动即报“无法定位程序输入点 TaskDialogIndirect”。

static ELEVATED_MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity version="1.0.0.0" processorArchitecture="*" name="ClipboardTool" type="win32"/>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="requireAdministrator" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <!-- Windows 10 / 11 -->
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2, PerMonitor</dpiAwareness>
      <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>
    </windowsSettings>
  </application>
</assembly>
"#;

fn should_elevate() -> bool {
    // 显式环境变量优先：CLIPBOARD_TOOL_ELEVATED=0 强制 asInvoker，=1 强制提权
    if let Ok(v) = std::env::var("CLIPBOARD_TOOL_ELEVATED") {
        return v != "0" && v.to_lowercase() != "false";
    }
    // 无显式设置时：release profile 默认提权（对应发布包），debug 默认不提权
    // Cargo 在构建时注入 PROFILE 环境变量
    matches!(std::env::var("PROFILE").as_deref(), Ok("release"))
}

fn main() {
    let mut attrs = tauri_build::Attributes::new();
    if should_elevate() {
        attrs = attrs.windows_attributes(
            tauri_build::WindowsAttributes::new().app_manifest(ELEVATED_MANIFEST.to_string()),
        );
    }
    tauri_build::try_build(attrs).expect("failed to run tauri-build");
}