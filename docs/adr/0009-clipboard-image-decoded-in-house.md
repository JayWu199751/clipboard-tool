# 剪贴板图片自己读、自己解，不走 arboard 的 get_image

`arboard::Clipboard::get_image()` 把 `CF_DIBV5` 直接交给 `image` 的 BMP 解码器，而那条路在「`BI_BITFIELDS` + V4/V5 头」上必然失败（机制见 [desktop-tool-pitfalls.md](../desktop-tool-pitfalls.md) 第 2 节）。失败方式最坑：不是崩溃也不是报错，而是返回「剪贴板里没有图片」——截图一条都进不了历史，用户只能看出「没记录」。所以图片这一路绕开 arboard：`main.rs` 用 Win32 自己取 `CF_DIBV5`（退回 `CF_DIB`）的原始字节，交给 `dib.rs` 解成 PNG。文字与写入方向（`set_text` / `set_image`）仍用 arboard。

## Consequences

- 这里**没有**可以「顺手简化回去」的余地：把 `clipboard_read_image_png` 换回 `clip.get_image()` 会让截图记录整条失效，而且失效是无声的。`dib.rs` 顶部注释、本条 ADR、以及 `真机探针` 那条 `#[ignore]` 测试是三道防线。
- 解码覆盖面由我们自己承诺：32bpp（`BI_RGB` / `BI_BITFIELDS`，含 alpha 掩码）、24bpp（`BI_RGB`）、`BI_PNG` 透传；调色板、16bpp、`BI_JPEG`、RLE、CMYK 一律不接，返回 `None`。扩覆盖面先加 `dib.rs` 单测，再改这里。
- 形状判定是纯函数（`dib::to_png`），所以「解得出来吗」全部在单测里钉住，不需要真机；真机只回答剩下那半个问题——某个截图工具到底写哪种 DIB 形状。

