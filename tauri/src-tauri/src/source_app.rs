// 前台应用信息与图标提取：resources/app-icon-helper.cs 的进程内移植。
// 原实现是一次性 C# 助手进程（stdout 末行 JSON）；Rust 版直接在主进程调用 Win32，
// 一次性进程与 execFile 解析整体退役。图标按 exePath 缓存（与 main.js 的 iconCache 等价）。

use base64::Engine;
use std::collections::HashMap;
use std::io::Cursor;
use std::os::windows::ffi::OsStrExt;

use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
    BITMAPINFOHEADER, DIB_RGB_COLORS,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::Win32::UI::Shell::ExtractAssociatedIconW;
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, GetForegroundWindow, GetIconInfo, GetWindowTextW, GetWindowThreadProcessId,
    HICON, ICONINFO,
};

pub struct ForegroundAppInfo {
    pub exe_path: String,
    pub app_name: String,
    pub window_title: String,
    pub icon_data_url: Option<String>,
}

fn to_wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

fn wide_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

// 进程 exe 完整路径（OpenProcess + QueryFullProcessImageNameW，可处理部分受保护进程）
fn get_exe_path(pid: u32) -> String {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let result = (|| {
            let mut buf = [0u16; 1024];
            let mut size = buf.len() as u32;
            if QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut size).is_ok() {
                Ok(wide_to_string(&buf[..size as usize]))
            } else {
                Err(())
            }
        })();
        let _ = CloseHandle(handle);
        result.unwrap_or_default()
    }
}

// HICON → PNG 字节：GetIconInfo 拿位图，GetDIBits 读 32bpp BGRA 转 RGBA
fn hicon_to_png(hicon: HICON) -> Option<Vec<u8>> {
    unsafe {
        let mut info = ICONINFO::default();
        if GetIconInfo(hicon, &mut info).is_err() {
            return None;
        }
        let result = (|| {
            let hbm = info.hbmColor;
            if hbm.is_invalid() {
                return None;
            }
            let mut bm = BITMAP::default();
            if GetObjectW(
                hbm.into(),
                std::mem::size_of::<BITMAP>() as i32,
                Some(&mut bm as *mut _ as *mut _),
            ) == 0
            {
                return None;
            }
            let (w, h) = (bm.bmWidth as i32, bm.bmHeight as i32);
            if w <= 0 || h <= 0 {
                return None;
            }
            let screen_dc = GetDC(None);
            let mem_dc = CreateCompatibleDC(Some(screen_dc));
            let mut bmi = BITMAPINFO::default();
            bmi.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                // 负高度 = top-down 行序
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0, // BI_RGB
                ..Default::default()
            };
            let mut pixels = vec![0u8; (w * h * 4) as usize];
            let lines = GetDIBits(
                mem_dc,
                hbm,
                0,
                h as u32,
                Some(pixels.as_mut_ptr() as *mut _),
                &mut bmi,
                DIB_RGB_COLORS,
            );
            let _ = DeleteDC(mem_dc);
            if lines == 0 {
                return None;
            }
            // BGRA → RGBA
            for px in pixels.chunks_exact_mut(4) {
                px.swap(0, 2);
            }
            // 若整图 alpha 全 0（GDI 图标常不带 alpha），按 mask 全不透明处理
            if pixels.chunks_exact(4).all(|px| px[3] == 0) {
                for px in pixels.chunks_exact_mut(4) {
                    px[3] = 255;
                }
            }
            let img = image::RgbaImage::from_raw(w as u32, h as u32, pixels)?;
            let mut png = Vec::new();
            img.write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
            Some(png)
        })();
        if !info.hbmColor.is_invalid() {
            let _ = DeleteObject(info.hbmColor.into());
        }
        if !info.hbmMask.is_invalid() {
            let _ = DeleteObject(info.hbmMask.into());
        }
        result
    }
}

fn extract_icon_png(exe_path: &str) -> Option<Vec<u8>> {
    unsafe {
        // ExtractAssociatedIconW 的路径缓冲是定长 128（含 NUL），超长截断
        let wide = to_wide(exe_path);
        let mut path_buf = [0u16; 128];
        let copy_len = wide.len().min(127);
        path_buf[..copy_len].copy_from_slice(&wide[..copy_len]);
        let mut index: u16 = 0;
        let hinstance = GetModuleHandleW(None).unwrap_or_default();
        let hicon = ExtractAssociatedIconW(
            Some(windows::Win32::Foundation::HINSTANCE(hinstance.0)),
            &mut path_buf,
            &mut index,
        );
        let png = hicon_to_png(hicon);
        let _ = DestroyIcon(hicon);
        png
    }
}

// 获取前台应用信息；icon_cache 为 exePath -> dataUrl 的进程内缓存（避免重复提取）。
// 任一环节失败静默降级（与原助手超时/解析失败的降级策略一致）。
pub fn get_foreground_app_info(icon_cache: &mut HashMap<String, Option<String>>) -> Option<ForegroundAppInfo> {    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }

        let exe_path = get_exe_path(pid);

        // 窗口标题（辅助识别，如浏览器标签）
        let mut title_buf = [0u16; 512];
        let n = GetWindowTextW(hwnd, &mut title_buf);
        let window_title = wide_to_string(&title_buf[..n.max(0) as usize]);

        let app_name = if exe_path.is_empty() {
            String::new()
        } else {
            std::path::Path::new(&exe_path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default()
        };

        // 图标：缓存命中跳过提取；未命中提取后写入缓存（含失败 None 的负缓存）
        let icon_data_url = if exe_path.is_empty() {
            None
        } else if let Some(cached) = icon_cache.get(&exe_path) {
            cached.clone()
        } else {
            let icon = extract_icon_png(&exe_path).map(|png| {
                format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png))
            });
            icon_cache.insert(exe_path.clone(), icon.clone());
            icon
        };

        Some(ForegroundAppInfo { exe_path, app_name, window_title, icon_data_url })
    }
}
