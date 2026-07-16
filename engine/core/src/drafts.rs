//! Draft file operations: list / save (upsert) / delete.
//!
//! Drafts are unpublished notes-in-progress. Unlike `notes/`, the drafts
//! directory (`<root>/drafts`, see [`Config::drafts_dir`]) is **never scanned
//! or indexed** — it is a plain working store. Because it lives on the home
//! device, every paired client shares the same drafts (there is no per-device
//! local storage anymore).
//!
//! Each draft is a single file `<id>.md`. The `id` is an opaque token
//! (charset `[A-Za-z0-9_-]`, ≤64 chars) so it never needs renaming as the
//! draft's first-line title changes while the user types. `editedAt` is the
//! file mtime in epoch **milliseconds** (matching the client `Draft` type).

use anyhow::{Context, Result, bail};
use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::config::Config;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftMeta {
    pub id: String,
    pub text: String,
    /// Epoch milliseconds.
    pub edited_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedDraft {
    pub id: String,
    /// Epoch milliseconds.
    pub edited_at: i64,
}

/// Every draft, newest first (by mtime). A missing drafts dir is not an
/// error — it simply means no drafts yet.
pub fn list_drafts(cfg: &Config) -> Result<Vec<DraftMeta>> {
    let dir = &cfg.drafts_dir;
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).with_context(|| format!("read {}", dir.display()))? {
        let entry = entry?;
        let path = entry.path();
        if !is_draft_file(&path) {
            continue;
        }
        let Some(id) = draft_id_from_path(&path) else {
            continue;
        };
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(_) => continue, // skip unreadable files rather than fail the whole list
        };
        let edited_at = file_mtime_ms(&path).unwrap_or(0);
        out.push(DraftMeta { id, text, edited_at });
    }
    out.sort_by(|a, b| b.edited_at.cmp(&a.edited_at));
    Ok(out)
}

/// Create or overwrite a draft. `id` omitted → a fresh id is generated and
/// returned. Empty/whitespace `text` is rejected (nothing to keep).
pub fn save_draft(cfg: &Config, id: Option<String>, text: &str) -> Result<SavedDraft> {
    if text.trim().is_empty() {
        bail!("empty draft");
    }
    let id = match id {
        Some(raw) => {
            let trimmed = raw.trim().to_string();
            if trimmed.is_empty() {
                generate_draft_id()?
            } else {
                validate_id(&trimmed)?;
                trimmed
            }
        }
        None => generate_draft_id()?,
    };

    let dir = drafts_root(cfg, true)?;
    let full = dir.join(format!("{id}.md"));
    std::fs::write(&full, text).with_context(|| format!("write {}", full.display()))?;
    let edited_at = file_mtime_ms(&full).unwrap_or(0);
    Ok(SavedDraft { id, edited_at })
}

/// Delete a draft. Idempotent — deleting a missing id is not an error (the
/// draft may already have been published or removed on another device).
pub fn delete_draft(cfg: &Config, id: &str) -> Result<()> {
    validate_id(id)?;
    let dir = &cfg.drafts_dir;
    if !dir.is_dir() {
        return Ok(());
    }
    let full = dir.join(format!("{id}.md"));
    match std::fs::remove_file(&full) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).with_context(|| format!("delete {}", full.display())),
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// The drafts dir. `create` mkdir -p's it (write paths).
fn drafts_root(cfg: &Config, create: bool) -> Result<PathBuf> {
    if create {
        std::fs::create_dir_all(&cfg.drafts_dir)
            .with_context(|| format!("create {}", cfg.drafts_dir.display()))?;
    }
    Ok(cfg.drafts_dir.clone())
}

/// A draft id is opaque: `[A-Za-z0-9_-]`, 1..=64 chars. This doubles as
/// path-traversal protection — no `/`, `.`, `..` can ever appear, so the id
/// can only name a file directly inside the drafts dir.
fn validate_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 64 {
        bail!("invalid draft id length: {id}");
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        bail!("invalid draft id (allowed: A-Za-z0-9_-): {id}");
    }
    Ok(())
}

fn is_draft_file(p: &Path) -> bool {
    p.is_file()
        && p.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("md"))
            .unwrap_or(false)
}

/// Draft id = the file stem, but only if the stem is a valid opaque id
/// (files a user dropped in by hand with odd names are ignored).
fn draft_id_from_path(p: &Path) -> Option<String> {
    let stem = p.file_stem()?.to_str()?;
    validate_id(stem).ok().map(|()| stem.to_string())
}

fn file_mtime_ms(p: &Path) -> Result<i64> {
    Ok(std::fs::metadata(p)?
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0))
}

/// Opaque 12-byte random id, hex-encoded (24 chars). Same random source as
/// the serve/tunnel token generators.
fn generate_draft_id() -> Result<String> {
    let mut bytes = [0u8; 12];
    getrandom::fill(&mut bytes).map_err(|e| anyhow::anyhow!("random source failed: {e}"))?;
    Ok(hex::encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::validate_id;

    #[test]
    fn id_validation() {
        assert!(validate_id("abc123").is_ok());
        assert!(validate_id("A-Z_0-9").is_ok());
        assert!(validate_id("").is_err());
        assert!(validate_id("../etc").is_err());
        assert!(validate_id("a/b").is_err());
        assert!(validate_id("a.b").is_err());
        assert!(validate_id(&"x".repeat(65)).is_err());
    }
}
