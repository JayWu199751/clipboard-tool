// DIB（Device-Independent Bitmap）→ PNG：剪贴板图片的解码判定。
//
// 为什么自己解，不用 arboard 的 get_image：它把 CF_DIBV5 直接喂给 image 的 BMP 解码器，
// 而那个解码器在「BI_BITFIELDS + V4/V5 头」上把像素起点算多了 12 字节——掩码本来就躺在
// 头里，它又按 BITMAPINFOHEADER 的规矩在头之后再跳 12 字节。于是整幅图往后错 12 字节、
// 最后一行读不完 → UnexpectedEof → arboard 报 ConversionFailure → 截图一条都进不了历史。
// PixPin、系统截图这类 32bpp 截图全中；image 0.25.9 与 0.25.10 都这样，钉版本躲不开。
// 结论与复现见 docs/desktop-tool-pitfalls.md。
//
// 这里是判定（纯字节变换，不碰剪贴板、不碰窗口），所以进 module 配单测；
// 打开剪贴板取原始字节属于效果，留在 main.rs。
//
// 覆盖面：32bpp（BI_RGB / BI_BITFIELDS，含 alpha 掩码）、24bpp（BI_RGB）、BI_PNG 透传。
// 其余（调色板、16bpp、BI_JPEG、RLE、CMYK）一律 None，与改之前的实际覆盖面一致，不做隐性承诺。

use image::RgbaImage;

const BI_RGB: u32 = 0;
const BI_BITFIELDS: u32 = 3;
const BI_PNG: u32 = 6;

fn u16_at(b: &[u8], off: usize) -> u16 {
    b.get(off..off + 2).map(|s| u16::from_le_bytes(s.try_into().unwrap())).unwrap_or(0)
}

fn u32_at(b: &[u8], off: usize) -> u32 {
    b.get(off..off + 4).map(|s| u32::from_le_bytes(s.try_into().unwrap())).unwrap_or(0)
}

/// 通道掩码占的那一段连续位
#[derive(Clone, Copy)]
struct Field {
    shift: u32,
    bits: u32,
}

/// 掩码必须是连续的一段 1，且不超过 16 位；否则视为坏头
fn field(mask: u32) -> Option<Field> {
    if mask == 0 {
        return None;
    }
    let shift = mask.trailing_zeros();
    let bits = (mask >> shift).count_ones();
    if bits == 0 || bits > 16 || ((1u32 << bits) - 1) << shift != mask {
        return None;
    }
    Some(Field { shift, bits })
}

/// 按通道位置取值并拉伸到 8 位
fn channel(px: u32, f: Field) -> u8 {
    let raw = (px >> f.shift) & ((1u32 << f.bits) - 1);
    if f.bits >= 8 {
        (raw >> (f.bits - 8)) as u8
    } else {
        (raw * 255 / ((1u32 << f.bits) - 1)) as u8
    }
}

/// 解 DIB 并编码成 PNG；不是我们支持的 DIB 就返回 None
pub fn to_png(dib: &[u8]) -> Option<Vec<u8>> {
    let header_size = u32_at(dib, 0) as usize;
    // 只认 BITMAPINFOHEADER(40) 与 V2..V5(52/56/108/124)；CORE 头(12)不接
    if !matches!(header_size, 40 | 52 | 56 | 108 | 124) || dib.len() < header_size {
        return None;
    }
    let width = u32_at(dib, 4) as i32;
    let raw_height = u32_at(dib, 8) as i32;
    let bit_count = u16_at(dib, 14) as u32;
    let compression = u32_at(dib, 16);
    if u16_at(dib, 12) != 1 || width <= 0 || raw_height == 0 {
        return None;
    }
    let height = raw_height.unsigned_abs() as usize;
    let top_down = raw_height < 0;
    let width = width as usize;

    // 掩码位置：BITMAPINFOHEADER 的 BI_BITFIELDS 把 12 字节掩码接在头后，V2 及以后在头里
    let (mut r_mask, mut g_mask, mut b_mask, mut a_mask, pixel_offset) = match header_size {
        40 if compression == BI_BITFIELDS => {
            (u32_at(dib, 40), u32_at(dib, 44), u32_at(dib, 48), 0, 52)
        }
        40 => (0, 0, 0, 0, 40),
        52 => (u32_at(dib, 40), u32_at(dib, 44), u32_at(dib, 48), 0, 52),
        n => (u32_at(dib, 40), u32_at(dib, 44), u32_at(dib, 48), u32_at(dib, 52), n),
    };

    // BI_PNG：像素区就是一个完整的 PNG 文件，验一下头再原样透传
    if compression == BI_PNG {
        let png = dib.get(pixel_offset..)?;
        let mut cursor = std::io::Cursor::new(png);
        image::codecs::png::PngDecoder::new(&mut cursor).ok()?;
        return Some(png.to_vec());
    }
    if compression != BI_RGB && compression != BI_BITFIELDS {
        return None;
    }

    // 三个颜色掩码全缺（BI_RGB 的常态）就按 B,G,R 补齐；alpha 掩码只在 V3 及以后、
    // 且非零时才认——这正是 PixPin 这类截图的写法：compression 仍写 BI_RGB，
    // 但 bV5AlphaMask 是 0xff000000，第四个字节确实是 alpha。
    if r_mask == 0 && g_mask == 0 && b_mask == 0 {
        (r_mask, g_mask, b_mask) = (0x00ff_0000, 0x0000_ff00, 0x0000_00ff);
        if header_size < 56 {
            a_mask = 0;
        }
    }
    let (r_field, g_field, b_field) = (field(r_mask)?, field(g_mask)?, field(b_mask)?);
    let a_field = if a_mask == 0 { None } else { Some(field(a_mask)?) };

    if bit_count != 24 && bit_count != 32 {
        return None;
    }
    // 行按 4 字节对齐；最后一行允许没有补齐的填充，免得把边界算死
    let row_bytes = (width * bit_count as usize + 31) / 32 * 4;
    let last_row_bytes = (width * bit_count as usize + 7) / 8;
    let needed = (height - 1).checked_mul(row_bytes)?.checked_add(last_row_bytes)?;
    let pixels = dib.get(pixel_offset..pixel_offset.checked_add(needed)?)?;

    let mut rgba = vec![0u8; width.checked_mul(height)?.checked_mul(4)?];
    for y in 0..height {
        // DIB 默认自下而上，负高度才是自上而下
        let src_y = if top_down { y } else { height - 1 - y };
        let Some(row) = pixels.get(src_y * row_bytes..) else { return None };
        let Some(dst) = rgba.get_mut(y * width * 4..(y + 1) * width * 4) else { return None };
        for (x, px) in dst.chunks_exact_mut(4).enumerate() {
            let pixel = if bit_count == 24 {
                match row.get(x * 3..x * 3 + 3) {
                    Some(t) => [t[2], t[1], t[0], 255],
                    None => [0, 0, 0, 0],
                }
            } else {
                let v = u32_at(row, x * 4);
                [
                    channel(v, r_field),
                    channel(v, g_field),
                    channel(v, b_field),
                    a_field.map_or(255, |f| channel(v, f)),
                ]
            };
            px.copy_from_slice(&pixel);
        }
    }

    let img = RgbaImage::from_raw(width as u32, height as u32, rgba)?;
    let mut png = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
    Some(png)
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)] // 测试名用中文描述规则，snake_case 检查不适用
    use super::*;

    /// 造一个 DIB：头 + 像素（BGRA 或 BGR）。rows 按缓冲区的行序给——
    /// 自下而上的 DIB 里，给的最后一行才是视觉第一行
    fn dib(
        header_size: usize,
        w: i32,
        h: i32,
        bit_count: u16,
        compression: u32,
        masks: (u32, u32, u32, u32),
        rows: &[Vec<u8>],
    ) -> Vec<u8> {
        let mut buf = vec![0u8; header_size];
        buf[0..4].copy_from_slice(&(header_size as u32).to_le_bytes());
        buf[4..8].copy_from_slice(&(w as u32).to_le_bytes());
        buf[8..12].copy_from_slice(&(h as u32).to_le_bytes());
        buf[12..14].copy_from_slice(&1u16.to_le_bytes());
        buf[14..16].copy_from_slice(&bit_count.to_le_bytes());
        buf[16..20].copy_from_slice(&compression.to_le_bytes());
        // 掩码落在头里的位置（V2 及以后）；BITMAPINFOHEADER 时这里越界，改由下面接头后
        for (i, m) in [masks.0, masks.1, masks.2, masks.3].into_iter().enumerate() {
            let off = 40 + i * 4;
            if off + 4 <= buf.len() {
                buf[off..off + 4].copy_from_slice(&m.to_le_bytes());
            }
        }
        if header_size == 40 && compression == BI_BITFIELDS {
            for m in [masks.0, masks.1, masks.2] {
                buf.extend_from_slice(&m.to_le_bytes());
            }
        }
        for row in rows {
            buf.extend_from_slice(row);
            // 行补齐到 4 字节
            let stride = (row.len() + 3) / 4 * 4;
            buf.resize(buf.len() + stride - row.len(), 0);
        }
        buf
    }

    fn rgba_of(png: &[u8]) -> (u32, u32, Vec<u8>) {
        let img = image::load_from_memory(png).expect("产出的字节必须是可解码的 PNG");
        let rgba = img.as_rgba8().expect("PNG 应带 alpha 通道").clone();
        (rgba.width(), rgba.height(), rgba.into_raw())
    }

    #[test]
    fn pixpin截图形状_V5头32bpp带alpha掩码_能解出PNG() {
        // 回归本 bug 的最小形状：BITMAPV5HEADER + BI_RGB + alphaMask=0xff000000，
        // 像素 BGRA、自下而上。改之前 arboard 在这形状上必报 ConversionFailure。
        let d = dib(
            124,
            2,
            2,
            32,
            BI_RGB,
            (0, 0, 0, 0xff00_0000),
            &[vec![0xff, 0x21, 0x1a, 0xff, 0x10, 0x20, 0x30, 0x80],
              vec![0x00, 0x00, 0xff, 0xff, 0x00, 0xff, 0x00, 0x00]],
        );
        let png = to_png(&d).expect("截图形状必须解得出 PNG");
        let (w, h, px) = rgba_of(&png);
        assert_eq!((w, h), (2, 2));
        // 视觉第一行 = 缓冲区的最后一行（自下而上）；BGRA(00,00,ff,ff) → RGBA(ff,00,00,ff)
        assert_eq!(&px[0..4], &[0xff, 0x00, 0x00, 0xff]);
        // 第二行第二像素：BGRA(0x10,0x20,0x30,0x80) → RGBA(0x30,0x20,0x10,0x80)，alpha 要留住
        assert_eq!(&px[12..16], &[0x30, 0x20, 0x10, 0x80]);
    }

    #[test]
    fn 位域掩码接在40字节头后_也能解() {
        // CF_DIB 的形状：BITMAPINFOHEADER + BI_BITFIELDS + 12 字节掩码 + 像素
        let d = dib(
            40,
            1,
            1,
            32,
            BI_BITFIELDS,
            (0x00ff_0000, 0x0000_ff00, 0x0000_00ff, 0),
            &[vec![0x1a, 0x21, 0x22, 0xff]],
        );
        let png = to_png(&d).expect("CF_DIB 形状应解得出 PNG");
        let (_, _, px) = rgba_of(&png);
        assert_eq!(&px[0..4], &[0x22, 0x21, 0x1a, 0xff]);
    }

    #[test]
    fn 二十四位BI_RGB按BGR读且行补齐被跳过() {
        // 宽 3 的 24bpp 行是 9 字节，要补到 12；补位不得混进像素
        let mut row = Vec::new();
        for i in 0..3 {
            row.extend_from_slice(&[i * 10, i * 10 + 1, i * 10 + 2]); // B,G,R
        }
        let d = dib(40, 3, 1, 24, BI_RGB, (0, 0, 0, 0), &[row]);
        let png = to_png(&d).expect("24bpp 应解得出 PNG");
        let (w, _, px) = rgba_of(&png);
        assert_eq!(w, 3);
        assert_eq!(&px[0..4], &[2, 1, 0, 255]);
        assert_eq!(&px[8..12], &[22, 21, 20, 255]);
    }

    #[test]
    fn 负高度是自上而下_行序不颠倒() {
        let rows = vec![vec![1, 0, 0, 255], vec![2, 0, 0, 255]];
        let up = dib(40, 1, -2, 32, BI_RGB, (0, 0, 0, 0), &rows);
        let down = dib(40, 1, 2, 32, BI_RGB, (0, 0, 0, 0), &rows);
        let (_, _, a) = rgba_of(&to_png(&up).unwrap());
        let (_, _, b) = rgba_of(&to_png(&down).unwrap());
        assert_eq!(&a[0..4], &[0, 0, 1, 255], "自上而下：第一行就是给的第一行");
        assert_eq!(&b[0..4], &[0, 0, 2, 255], "自下而上：给的最后一行才是第一行");
        // 两种方向的行序正好相反：a 的第二行就是 b 的第一行
        assert_eq!(&a[4..8], &b[0..4]);
    }

    #[test]
    fn BI_PNG像素区原样透传() {
        let inner = {
            let img = RgbaImage::from_pixel(1, 1, image::Rgba([7, 8, 9, 255]));
            let mut buf = Vec::new();
            img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
                .unwrap();
            buf
        };
        let mut d = dib(124, 1, 1, 32, BI_PNG, (0, 0, 0, 0), &[]);
        d.extend_from_slice(&inner);
        assert_eq!(to_png(&d).as_deref(), Some(inner.as_slice()));
    }

    #[test]
    fn 不支持的形状一律不接() {
        // 8bpp 调色板
        let palette = dib(40, 1, 1, 8, BI_RGB, (0, 0, 0, 0), &[vec![1]]);
        assert_eq!(to_png(&palette), None);
        // 16bpp
        assert_eq!(to_png(&dib(40, 1, 1, 16, BI_RGB, (0, 0, 0, 0), &[vec![1, 2]])), None);
        // CORE 头(12)
        let mut core = vec![0u8; 12];
        core[0..4].copy_from_slice(&12u32.to_le_bytes());
        assert_eq!(to_png(&core), None);
        // 掩码不连续
        assert_eq!(
            to_png(&dib(124, 1, 1, 32, BI_BITFIELDS, (0x00f0_00f0, 0, 0xff, 0), &[vec![0; 4]])),
            None
        );
    }

    #[test]
    fn 像素数据不足时不分配也不崩() {
        // 声称 4000×4000，实际只给了头：必须在分配像素缓冲之前返回 None
        let mut d = vec![0u8; 124];
        d[0..4].copy_from_slice(&124u32.to_le_bytes());
        d[4..8].copy_from_slice(&4000u32.to_le_bytes());
        d[8..12].copy_from_slice(&4000u32.to_le_bytes());
        d[12..14].copy_from_slice(&1u16.to_le_bytes());
        d[14..16].copy_from_slice(&32u16.to_le_bytes());
        assert_eq!(to_png(&d), None);
    }
}
