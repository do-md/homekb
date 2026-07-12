//! Filesystem walk: enumerate eligible .md files under the knowledge base.

use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Debug, Clone)]
pub struct FsEntry {
    pub path: PathBuf,
    pub mtime: i64,
    pub size: i64,
}

/// Return all .md files under `root`, excluding hidden files/dirs and
/// editor temp files. Paths are absolute (canonicalized via WalkDir).
pub fn scan(root: &Path) -> Vec<FsEntry> {
    let mut out = Vec::new();
    for entry in WalkDir::new(root).follow_links(false).into_iter().filter_entry(visible) {
        let entry = match entry {
            Ok(e) => e,
            Err(err) => {
                tracing::warn!("scan error: {}", err);
                continue;
            }
        };
        if !entry.file_type().is_file() { continue; }
        let p = entry.path();
        if !is_markdown(p) { continue; }
        if is_editor_temp(p) { continue; }

        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let size = meta.len() as i64;
        out.push(FsEntry { path: p.to_path_buf(), mtime, size });
    }
    out
}

fn visible(e: &walkdir::DirEntry) -> bool {
    !e.file_name()
        .to_str()
        .map(|s| s.starts_with('.'))
        .unwrap_or(false)
}

fn is_markdown(p: &Path) -> bool {
    p.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("md")).unwrap_or(false)
}

fn is_editor_temp(p: &Path) -> bool {
    let name = match p.file_name().and_then(|s| s.to_str()) {
        Some(n) => n,
        None => return true,
    };
    name.starts_with('~')
        || name.starts_with('#')
        || name.ends_with(".swp")
        || name.ends_with(".tmp")
}
