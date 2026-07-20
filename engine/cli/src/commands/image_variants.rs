//! Image variant service (docs/ARCHITECTURE.md "Image variant service"):
//! on-demand resize/transcode of image assets with a regenerable cache under
//! `<root>/cache/images/`. Shared by serve (`GET /assets/*`) and tunnel (asset
//! SSE channel) so every access path serves identical variants.
//!
//! Protocol (aligned with the claude-os image service this is ported from):
//! - `?raw=1`                → original bytes untouched
//! - `?w=&h=&fit=&q=&f=`     → explicit transform
//! - no params               → web default: long edge ≤ 2000, q 80, `f=auto`
//! - `f=auto` negotiation: Accept has `image/webp` → webp; png source → png; else jpeg
//! - gif/svg/non-images always pass through raw; heic/heif *must* transcode
//!   (`sips` subprocess, macOS only — elsewhere a HEIC request resolves to None).
//!
//! Cache key = hash(source path + mtime + size + params + output format), so
//! editing the source invalidates automatically. Variants are built into a tmp
//! file and atomically renamed; concurrent duplicate builds are harmless.

use anyhow::{Context, Result};
use homekb_core::Config;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

use super::assets::guess_mime;

/// Web-friendly default variant (docs/ARCHITECTURE.md "Image variant service").
const DEFAULT_MAX_DIM: u32 = 2000;
const DEFAULT_QUALITY: u8 = 80;
const MIN_DIM: u32 = 16;
const MAX_DIM: u32 = 6000;
const MIN_QUALITY: u8 = 20;
const MAX_QUALITY: u8 = 95;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fit {
    Inside,
    Cover,
    Contain,
}

impl Fit {
    fn key(self) -> &'static str {
        match self {
            Fit::Inside => "inside",
            Fit::Cover => "cover",
            Fit::Contain => "contain",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormatChoice {
    Auto,
    Webp,
    Jpeg,
    Png,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutFormat {
    Webp,
    Jpeg,
    Png,
}

impl OutFormat {
    fn ext(self) -> &'static str {
        match self {
            OutFormat::Webp => "webp",
            OutFormat::Jpeg => "jpeg",
            OutFormat::Png => "png",
        }
    }
    fn mime(self) -> &'static str {
        match self {
            OutFormat::Webp => "image/webp",
            OutFormat::Jpeg => "image/jpeg",
            OutFormat::Png => "image/png",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct VariantParams {
    pub raw: bool,
    pub w: Option<u32>,
    pub h: Option<u32>,
    pub fit: Fit,
    pub q: u8,
    pub format: FormatChoice,
}

impl Default for VariantParams {
    fn default() -> Self {
        Self {
            raw: false,
            w: None,
            h: None,
            fit: Fit::Inside,
            q: DEFAULT_QUALITY,
            format: FormatChoice::Auto,
        }
    }
}

/// Parse the asset GET's query string (`w=800&f=webp`, no leading `?`).
/// Unknown keys are ignored; out-of-range values clamp (never error) — the
/// query is advisory rendering input, not an API to validate strictly.
pub fn parse_image_query(query: &str) -> VariantParams {
    let mut p = VariantParams::default();
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k {
            "raw" => p.raw = v == "1" || v == "true",
            "w" => p.w = parse_dim(v),
            "h" => p.h = parse_dim(v),
            "fit" => {
                p.fit = match v {
                    "cover" => Fit::Cover,
                    "contain" => Fit::Contain,
                    _ => Fit::Inside,
                }
            }
            "q" => {
                if let Ok(n) = v.parse::<u32>() {
                    if n > 0 {
                        p.q = (n as u8).clamp(MIN_QUALITY, MAX_QUALITY);
                    }
                }
            }
            "f" | "format" => {
                p.format = match v.to_ascii_lowercase().as_str() {
                    "webp" => FormatChoice::Webp,
                    "jpeg" | "jpg" => FormatChoice::Jpeg,
                    "png" => FormatChoice::Png,
                    _ => FormatChoice::Auto,
                }
            }
            _ => {}
        }
    }
    p
}

fn parse_dim(v: &str) -> Option<u32> {
    v.parse::<u32>()
        .ok()
        .filter(|n| *n > 0)
        .map(|n| n.clamp(MIN_DIM, MAX_DIM))
}

/// The representation to serve: the original file or a cached variant.
pub struct ResolvedImage {
    pub path: PathBuf,
    pub mime: &'static str,
    /// Quoted HTTP ETag (variant key, or source identity on the raw path).
    pub etag: String,
    /// True when the representation depends on the Accept header (`Vary: Accept`).
    pub varies: bool,
}

/// Derived-variant cache root — inside the data root by design (data cohesion;
/// see docs/ARCHITECTURE.md "User-side directory layout").
pub fn image_cache_root(config: &Config) -> PathBuf {
    config.root.join("cache").join("images")
}

fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

/// Source formats that can go through the transform pipeline. gif (animation)
/// and svg (vector) always pass through raw.
fn transformable(ext: &str) -> bool {
    matches!(ext, "jpg" | "jpeg" | "png" | "webp" | "heic" | "heif")
}

/// Browsers can't render these — they only leave as a transcoded variant.
fn must_transcode(ext: &str) -> bool {
    matches!(ext, "heic" | "heif")
}

fn negotiate(source_ext: &str, accept: Option<&str>) -> OutFormat {
    if accept.is_some_and(|a| a.contains("image/webp")) {
        return OutFormat::Webp;
    }
    if source_ext == "png" {
        return OutFormat::Png; // alpha-safe
    }
    OutFormat::Jpeg
}

fn sha_hex(input: &str) -> String {
    hex::encode(Sha256::digest(input.as_bytes()))
}

/// Resolve source + params (+ Accept) to the file to serve. `None` = nothing
/// servable: source missing, or a HEIC that cannot be transcoded (missing
/// decoder / non-macOS) — HEIC has no browser-renderable fallback.
pub async fn resolve_variant(
    cache_root: &Path,
    source: &Path,
    params: &VariantParams,
    accept: Option<&str>,
) -> Option<ResolvedImage> {
    let meta = tokio::fs::metadata(source).await.ok()?;
    if !meta.is_file() {
        return None;
    }
    let ext = ext_of(source);
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let identity = format!("{}|{}|{}", source.display(), mtime_ms, meta.len());
    let raw = || ResolvedImage {
        path: source.to_path_buf(),
        mime: guess_mime(source),
        etag: format!("\"{}\"", &sha_hex(&identity)[..24]),
        varies: false,
    };

    if params.raw || !transformable(&ext) {
        return Some(raw());
    }
    if must_transcode(&ext) && !cfg!(target_os = "macos") {
        return None; // no HEIC decoder off macOS; raw bytes would be unrenderable
    }

    let out_format = match params.format {
        FormatChoice::Auto => negotiate(&ext, accept),
        FormatChoice::Webp => OutFormat::Webp,
        FormatChoice::Jpeg => OutFormat::Jpeg,
        FormatChoice::Png => OutFormat::Png,
    };
    let key = sha_hex(&format!(
        "{identity}|w={}|h={}|fit={}|q={}|f={}",
        params.w.map(|n| n.to_string()).unwrap_or_default(),
        params.h.map(|n| n.to_string()).unwrap_or_default(),
        params.fit.key(),
        params.q,
        out_format.ext(),
    ));
    let out_abs = cache_root
        .join(&key[..2])
        .join(format!("{key}.{}", out_format.ext()));
    let resolved = ResolvedImage {
        path: out_abs.clone(),
        mime: out_format.mime(),
        etag: format!("\"{}\"", &key[..24]),
        varies: true,
    };

    if tokio::fs::metadata(&out_abs)
        .await
        .map(|m| m.is_file())
        .unwrap_or(false)
    {
        return Some(resolved); // cache hit
    }

    let source_owned = source.to_path_buf();
    let source_ext = ext.clone();
    let params_owned = *params;
    let build = tokio::task::spawn_blocking(move || {
        build_variant(&source_owned, &source_ext, &out_abs, &params_owned, out_format)
    })
    .await;
    match build {
        Ok(Ok(())) => Some(resolved),
        Ok(Err(e)) => {
            // Transform failure (corrupt file etc.): fall back to the original
            // — except HEIC, which nothing can render.
            tracing::warn!("image variant build failed, falling back to raw: {e:#}");
            if must_transcode(&ext) { None } else { Some(raw()) }
        }
        Err(e) => {
            tracing::warn!("image variant task panicked: {e}");
            None
        }
    }
}

/// Fire-and-forget warm of the default web variants (both negotiation
/// outcomes) after an upload — first view then hits the cache.
pub async fn warm_default_variants(cache_root: PathBuf, source: PathBuf) {
    let params = VariantParams::default();
    let _ = resolve_variant(&cache_root, &source, &params, Some("image/webp")).await;
    let _ = resolve_variant(&cache_root, &source, &params, None).await;
}

// ── Blocking build pipeline ──────────────────────────────────────────────────

fn build_variant(
    source: &Path,
    source_ext: &str,
    out_abs: &Path,
    params: &VariantParams,
    out_format: OutFormat,
) -> Result<()> {
    let parent = out_abs
        .parent()
        .context("variant path has no parent directory")?;
    std::fs::create_dir_all(parent)?;

    // HEIC/HEIF: decode to a high-quality JPEG intermediate via sips (macOS).
    let mut tmp_decoded: Option<PathBuf> = None;
    let input: PathBuf = if must_transcode(source_ext) {
        let tmp = parent.join(format!("{}.decode.jpg", random_suffix()));
        sips_decode_to_jpeg(source, &tmp)?;
        tmp_decoded = Some(tmp.clone());
        tmp
    } else {
        source.to_path_buf()
    };

    let result = (|| -> Result<()> {
        let img = decode_oriented(&input)?;
        let img = apply_resize(img, params);
        encode_to(out_abs, &img, params.q, out_format)
    })();

    if let Some(tmp) = tmp_decoded {
        let _ = std::fs::remove_file(tmp);
    }
    result
}

/// Decode with EXIF orientation applied (sharp's `.rotate()` equivalent).
fn decode_oriented(input: &Path) -> Result<image::DynamicImage> {
    use image::ImageDecoder;
    let reader = image::ImageReader::open(input)?.with_guessed_format()?;
    let mut decoder = reader.into_decoder()?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = image::DynamicImage::from_decoder(decoder)?;
    img.apply_orientation(orientation);
    Ok(img)
}

fn apply_resize(img: image::DynamicImage, params: &VariantParams) -> image::DynamicImage {
    use image::imageops::FilterType;
    let (sw, sh) = (img.width(), img.height());

    // No explicit box → the web default: long edge ≤ 2000, fit inside.
    let (bw, bh, fit) = match (params.w, params.h) {
        (None, None) => (DEFAULT_MAX_DIM, DEFAULT_MAX_DIM, Fit::Inside),
        (w, h) => {
            let fit = if w.is_some() && h.is_some() {
                params.fit
            } else {
                Fit::Inside // cover/contain need both dims; degrade to inside
            };
            (w.unwrap_or(u32::MAX), h.unwrap_or(u32::MAX), fit)
        }
    };

    match fit {
        Fit::Inside => {
            if sw <= bw && sh <= bh {
                img // never enlarge
            } else {
                img.resize(bw, bh, FilterType::Lanczos3)
            }
        }
        Fit::Cover => img.resize_to_fill(bw, bh, FilterType::Lanczos3),
        Fit::Contain => {
            // Letterbox to the exact box, centered; transparent background
            // (flattened to white if the output is jpeg — see encode_to).
            let inner = if sw <= bw && sh <= bh {
                img
            } else {
                img.resize(bw, bh, FilterType::Lanczos3)
            };
            let mut canvas = image::RgbaImage::from_pixel(bw, bh, image::Rgba([0, 0, 0, 0]));
            let x = (bw - inner.width()) / 2;
            let y = (bh - inner.height()) / 2;
            image::imageops::overlay(&mut canvas, &inner.to_rgba8(), x as i64, y as i64);
            image::DynamicImage::ImageRgba8(canvas)
        }
    }
}

fn encode_to(
    out_abs: &Path,
    img: &image::DynamicImage,
    quality: u8,
    out_format: OutFormat,
) -> Result<()> {
    let tmp = out_abs.with_extension(format!("{}.tmp", random_suffix()));
    let write = (|| -> Result<()> {
        match out_format {
            OutFormat::Webp => {
                let rgba = img.to_rgba8();
                let mem = webp::Encoder::from_rgba(&rgba, rgba.width(), rgba.height())
                    .encode(quality as f32);
                std::fs::write(&tmp, &*mem)?;
            }
            OutFormat::Jpeg => {
                // Jpeg has no alpha: flatten onto white.
                let rgb = image::DynamicImage::ImageRgb8(flatten_to_rgb(img));
                let file = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
                let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(file, quality);
                rgb.write_with_encoder(encoder)?;
            }
            OutFormat::Png => {
                let file = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
                img.write_with_encoder(image::codecs::png::PngEncoder::new(file))?;
            }
        }
        Ok(())
    })();
    match write {
        Ok(()) => {
            std::fs::rename(&tmp, out_abs)?; // atomic drop into the cache
            Ok(())
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

fn flatten_to_rgb(img: &image::DynamicImage) -> image::RgbImage {
    let rgba = img.to_rgba8();
    let mut out = image::RgbImage::new(rgba.width(), rgba.height());
    for (o, p) in out.pixels_mut().zip(rgba.pixels()) {
        let a = p[3] as u32;
        for c in 0..3 {
            o[c] = ((p[c] as u32 * a + 255 * (255 - a)) / 255) as u8;
        }
    }
    out
}

fn random_suffix() -> String {
    let mut bytes = [0u8; 8];
    let _ = getrandom::fill(&mut bytes);
    hex::encode(bytes)
}

#[cfg(target_os = "macos")]
fn sips_decode_to_jpeg(source: &Path, out: &Path) -> Result<()> {
    let status = std::process::Command::new("sips")
        .args(["-s", "format", "jpeg", "-s", "formatOptions", "95"])
        .arg(source)
        .arg("--out")
        .arg(out)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .context("failed to run sips")?;
    anyhow::ensure!(status.success(), "sips exited with {status}");
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn sips_decode_to_jpeg(_source: &Path, _out: &Path) -> Result<()> {
    anyhow::bail!("HEIC decoding requires macOS (sips)")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fresh scratch dir per test (no tempfile dev-dependency in this crate).
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "homekb-imgvar-{tag}-{}-{}",
            std::process::id(),
            random_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn block_on<F: std::future::Future>(fut: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(fut)
    }

    #[test]
    fn query_parsing_clamps_and_defaults() {
        let p = parse_image_query("");
        assert!(!p.raw);
        assert_eq!(p.w, None);
        assert_eq!(p.q, DEFAULT_QUALITY);
        assert_eq!(p.format, FormatChoice::Auto);

        let p = parse_image_query("raw=1");
        assert!(p.raw);

        let p = parse_image_query("w=8&h=99999&q=5&fit=cover&f=WEBP");
        assert_eq!(p.w, Some(MIN_DIM));
        assert_eq!(p.h, Some(MAX_DIM));
        assert_eq!(p.q, MIN_QUALITY);
        assert_eq!(p.fit, Fit::Cover);
        assert_eq!(p.format, FormatChoice::Webp);

        let p = parse_image_query("q=200&f=jpg");
        assert_eq!(p.q, MAX_QUALITY);
        assert_eq!(p.format, FormatChoice::Jpeg);
    }

    #[test]
    fn negotiation_prefers_webp_then_source() {
        assert_eq!(negotiate("jpg", Some("image/webp,*/*")), OutFormat::Webp);
        assert_eq!(negotiate("png", Some("*/*")), OutFormat::Png);
        assert_eq!(negotiate("jpg", None), OutFormat::Jpeg);
    }

    #[test]
    fn non_transformable_passes_through_raw() {
        let dir = scratch("gif");
        let src = dir.join("anim.gif");
        std::fs::write(&src, b"GIF89a-not-really").unwrap();
        let cache = dir.join("cache");
        let resolved = block_on(resolve_variant(
            &cache,
            &src,
            &VariantParams::default(),
            Some("image/webp"),
        ))
        .expect("raw pass-through");
        assert_eq!(resolved.path, src);
        assert_eq!(resolved.mime, "image/gif");
        assert!(!resolved.varies);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn default_variant_downscales_and_caches() {
        let dir = scratch("png");
        let src = dir.join("wide.png");
        // 3000x1000 source → default variant long edge 2000 → 2000x667.
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            3000,
            1000,
            image::Rgb([120, 30, 200]),
        ))
        .save(&src)
        .unwrap();
        let cache = dir.join("cache");

        let resolved = block_on(resolve_variant(
            &cache,
            &src,
            &VariantParams::default(),
            Some("image/webp"),
        ))
        .expect("variant");
        assert_eq!(resolved.mime, "image/webp");
        assert!(resolved.varies);
        assert!(resolved.path.starts_with(&cache));
        let img = image::ImageReader::open(&resolved.path)
            .unwrap()
            .with_guessed_format()
            .unwrap()
            .decode()
            .unwrap();
        assert_eq!(img.width(), 2000);
        assert!((666..=667).contains(&img.height()));

        // Second resolve hits the cache: identical path + etag.
        let again = block_on(resolve_variant(
            &cache,
            &src,
            &VariantParams::default(),
            Some("image/webp"),
        ))
        .unwrap();
        assert_eq!(again.path, resolved.path);
        assert_eq!(again.etag, resolved.etag);

        // raw=1 returns the untouched original.
        let raw = block_on(resolve_variant(
            &cache,
            &src,
            &parse_image_query("raw=1"),
            Some("image/webp"),
        ))
        .unwrap();
        assert_eq!(raw.path, src);
        assert_eq!(raw.mime, "image/png");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn small_source_never_enlarges() {
        let dir = scratch("small");
        let src = dir.join("small.png");
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            300,
            200,
            image::Rgb([1, 2, 3]),
        ))
        .save(&src)
        .unwrap();
        let cache = dir.join("cache");
        let resolved = block_on(resolve_variant(
            &cache,
            &src,
            &parse_image_query("w=1200"),
            None,
        ))
        .unwrap();
        let img = image::ImageReader::open(&resolved.path)
            .unwrap()
            .with_guessed_format()
            .unwrap()
            .decode()
            .unwrap();
        assert_eq!((img.width(), img.height()), (300, 200));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn source_edit_invalidates_cache_key() {
        let dir = scratch("inval");
        let src = dir.join("a.png");
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(50, 50, image::Rgb([9, 9, 9])))
            .save(&src)
            .unwrap();
        let cache = dir.join("cache");
        let first = block_on(resolve_variant(&cache, &src, &VariantParams::default(), None)).unwrap();
        // Rewrite the source with different content (size changes → new identity).
        image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(60, 60, |x, y| {
            image::Rgb([x as u8, y as u8, 7])
        }))
        .save(&src)
        .unwrap();
        let second =
            block_on(resolve_variant(&cache, &src, &VariantParams::default(), None)).unwrap();
        assert_ne!(first.path, second.path);
        assert_ne!(first.etag, second.etag);
        std::fs::remove_dir_all(dir).ok();
    }
}
