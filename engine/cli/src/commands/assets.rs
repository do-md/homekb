//! Asset helpers shared by `serve` (GET /assets/*) and `tunnel` (asset SSE event):
//! traversal-safe path resolution under `<root>/assets/` and extension-based
//! Content-Type guessing (no extra crate; the vocabulary below covers the
//! image/attachment types the pipeline produces).

use homekb_core::Config;
use std::path::{Component, Path, PathBuf};

/// Resolve `rel` (e.g. `images/foo.png`) against the assets root.
/// Returns None for anything that could escape the root (absolute paths,
/// `..`/`.` segments, empty segments, backslashes, NULs).
pub fn resolve_asset_path(config: &Config, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() || rel.contains('\\') || rel.contains('\0') {
        return None;
    }
    let candidate = Path::new(rel);
    if candidate.is_absolute() {
        return None;
    }
    for comp in candidate.components() {
        match comp {
            Component::Normal(seg) if !seg.is_empty() => {}
            _ => return None,
        }
    }
    Some(config.root.join("assets").join(candidate))
}

/// Extension → Content-Type. Unknown extensions fall back to octet-stream.
pub fn guess_mime(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        "txt" => "text/plain; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "json" => "application/json",
        "csv" => "text/csv; charset=utf-8",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}
