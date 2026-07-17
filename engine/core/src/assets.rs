//! Asset write path — the engine side of the upload contract
//! (docs/ARCHITECTURE.md "Binary asset channel", upload direction; serve
//! `POST /assets/<path>`).
//!
//! Clients *suggest* a relative asset path (`images/foo.png`); the engine owns
//! the final name: the kind directory is allowlisted, the filename is
//! sanitized, and collisions get a `-2` / `-3` … suffix (same convention as
//! `create_note`). Uploads always land in the shared `<root>/assets/` tree —
//! never a draft-scoped copy (see "Image references in notes").

use anyhow::{Result, bail};
use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::config::Config;

/// Directories under `assets/` that accept uploads.
const ALLOWED_KINDS: [&str; 2] = ["images", "attachments"];
/// Cap on the sanitized filename stem (bytes, char-boundary safe).
const MAX_STEM_LEN: usize = 120;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAsset {
    /// Final path relative to `<root>/assets/` (e.g. `images/foo-2.png`).
    pub path: String,
}

/// Write uploaded bytes under `<root>/assets/`. `suggested` must be
/// `<kind>/<filename>` with an allowlisted kind; returns the final relative
/// path after sanitizing + collision avoidance.
pub fn save_asset(cfg: &Config, suggested: &str, bytes: &[u8]) -> Result<SavedAsset> {
    save_asset_at(&cfg.root.join("assets"), suggested, bytes)
}

fn save_asset_at(assets_root: &Path, suggested: &str, bytes: &[u8]) -> Result<SavedAsset> {
    let (kind, name) = split_suggested(suggested)?;
    let (stem, ext) = sanitize_filename(name)?;

    let dir = assets_root.join(kind);
    std::fs::create_dir_all(&dir)?;

    let (filename, full) = collision_free(&dir, &stem, &ext);
    std::fs::write(&full, bytes)?;
    Ok(SavedAsset {
        path: format!("{kind}/{filename}"),
    })
}

fn split_suggested(suggested: &str) -> Result<(&str, &str)> {
    let mut parts = suggested.split('/');
    let (Some(kind), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
        bail!("asset path must be <kind>/<filename>: {suggested}");
    };
    if !ALLOWED_KINDS.contains(&kind) {
        bail!("asset kind not allowed: {kind}");
    }
    Ok((kind, name))
}

/// Reduce a client-supplied filename to a safe `(stem, ext)` pair: path
/// separators / NULs / control chars are rejected outright (they signal a
/// hostile or broken client, not a quirky filename), leading dots are
/// stripped (no hidden files, no `..`), and the stem is length-capped.
fn sanitize_filename(name: &str) -> Result<(String, String)> {
    if name.contains('\\') || name.contains('\0') || name.chars().any(char::is_control) {
        bail!("invalid characters in filename");
    }
    let trimmed = name.trim().trim_start_matches('.');
    if trimmed.is_empty() {
        bail!("empty filename");
    }
    let (stem, ext) = match trimmed.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && !e.is_empty() && e.len() <= 16 => {
            (s.to_string(), e.to_ascii_lowercase())
        }
        _ => (trimmed.to_string(), String::new()),
    };
    let mut stem = stem.trim().to_string();
    if stem.len() > MAX_STEM_LEN {
        let mut cut = MAX_STEM_LEN;
        while !stem.is_char_boundary(cut) {
            cut -= 1;
        }
        stem.truncate(cut);
    }
    if stem.is_empty() {
        bail!("empty filename");
    }
    Ok((stem, ext))
}

fn collision_free(dir: &Path, stem: &str, ext: &str) -> (String, PathBuf) {
    let compose = |suffix: &str| {
        if ext.is_empty() {
            format!("{stem}{suffix}")
        } else {
            format!("{stem}{suffix}.{ext}")
        }
    };
    let mut filename = compose("");
    let mut n = 2;
    while dir.join(&filename).exists() {
        filename = compose(&format!("-{n}"));
        n += 1;
    }
    let full = dir.join(&filename);
    (filename, full)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fresh scratch dir per test (no tempfile dev-dependency in this crate).
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "homekb-assets-test-{}-{tag}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn writes_and_returns_final_path() {
        let s = Scratch::new("write");
        let saved = save_asset_at(&s.0, "images/pic.png", b"bytes").unwrap();
        assert_eq!(saved.path, "images/pic.png");
        assert_eq!(std::fs::read(s.0.join("images/pic.png")).unwrap(), b"bytes");
    }

    #[test]
    fn collisions_get_numeric_suffix() {
        let s = Scratch::new("collide");
        assert_eq!(save_asset_at(&s.0, "images/pic.png", b"a").unwrap().path, "images/pic.png");
        assert_eq!(save_asset_at(&s.0, "images/pic.png", b"b").unwrap().path, "images/pic-2.png");
        assert_eq!(save_asset_at(&s.0, "images/pic.png", b"c").unwrap().path, "images/pic-3.png");
        // Contents stay distinct — no overwrite.
        assert_eq!(std::fs::read(s.0.join("images/pic.png")).unwrap(), b"a");
        assert_eq!(std::fs::read(s.0.join("images/pic-3.png")).unwrap(), b"c");
    }

    #[test]
    fn rejects_bad_kind_and_shape() {
        let s = Scratch::new("kind");
        assert!(save_asset_at(&s.0, "secrets/pic.png", b"x").is_err());
        assert!(save_asset_at(&s.0, "images/a/b.png", b"x").is_err());
        assert!(save_asset_at(&s.0, "images", b"x").is_err());
        assert!(save_asset_at(&s.0, "images/..", b"x").is_err());
        // A leading-dot name is stripped, not treated as traversal.
        assert_eq!(save_asset_at(&s.0, "images/...png", b"x").unwrap().path, "images/png");
    }

    #[test]
    fn sanitizes_names() {
        let s = Scratch::new("sanitize");
        assert!(save_asset_at(&s.0, "images/a\0b.png", b"x").is_err());
        assert!(save_asset_at(&s.0, "images/ ", b"x").is_err());
        assert_eq!(
            save_asset_at(&s.0, "images/Pic Name.PNG", b"x").unwrap().path,
            "images/Pic Name.png"
        );
        let long = "x".repeat(400);
        let saved = save_asset_at(&s.0, &format!("images/{long}.png"), b"x").unwrap();
        assert!(saved.path.len() <= "images/".len() + MAX_STEM_LEN + 4);
    }
}
