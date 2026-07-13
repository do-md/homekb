//! Note file operations: read / write / create / list.
//!
//! Every path-taking operation enforces:
//!   - the path is relative, contains no `..` / root components,
//!   - the extension is `.md`,
//!   - the canonicalized result still lives inside `notes_dir`
//!     (symlink-escape protection).

use anyhow::{Context, Result, bail};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};

use crate::config::{Config, relative_path};
use crate::{db, scanner};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteContent {
    pub path: String,
    pub content: String,
    /// Unix seconds.
    pub mtime: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedNote {
    /// Path relative to notes_dir.
    pub path: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocMeta {
    pub path: String,
    pub title: Option<String>,
    pub doc_type: Option<String>,
    /// Unix seconds.
    pub mtime: i64,
    pub size_bytes: i64,
}

/// Read a note. `rel_path` is relative to notes_dir.
pub fn read_note(cfg: &Config, rel_path: &str) -> Result<NoteContent> {
    let root = notes_root(cfg, false)?;
    let rel = validated_rel(rel_path)?;
    let full = root
        .join(&rel)
        .canonicalize()
        .with_context(|| format!("note not found: {rel_path}"))?;
    if !full.starts_with(&root) {
        bail!("path escapes notes dir: {rel_path}");
    }
    let content = std::fs::read_to_string(&full)
        .with_context(|| format!("read {}", full.display()))?;
    let mtime = file_mtime(&full)?;
    Ok(NoteContent {
        path: relative_path(&root, &full),
        content,
        mtime,
    })
}

/// Create or overwrite a note. Only `.md` files inside notes_dir are
/// allowed; parent directories are created as needed.
pub fn write_note(cfg: &Config, rel_path: &str, content: &str) -> Result<()> {
    let root = notes_root(cfg, true)?;
    let rel = validated_rel(rel_path)?;
    let full = root.join(&rel);

    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create {}", parent.display()))?;
        let canon_parent = parent
            .canonicalize()
            .with_context(|| format!("resolve {}", parent.display()))?;
        if !canon_parent.starts_with(&root) {
            bail!("path escapes notes dir: {rel_path}");
        }
    }
    // If the target already exists (possibly as a symlink), make sure the
    // real destination is still inside the notes dir before writing.
    if full.exists() {
        let canon = full
            .canonicalize()
            .with_context(|| format!("resolve {}", full.display()))?;
        if !canon.starts_with(&root) {
            bail!("path escapes notes dir: {rel_path}");
        }
    }

    std::fs::write(&full, content).with_context(|| format!("write {}", full.display()))?;
    Ok(())
}

/// Create a new note from raw markdown. The filename is a slug of the
/// title (explicit `title` > first `# H1` > first non-empty line,
/// truncated); collisions get a `-2` / `-3` … suffix.
pub fn create_note(cfg: &Config, content: &str, title: Option<String>) -> Result<CreatedNote> {
    let root = notes_root(cfg, true)?;

    let title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .or_else(|| extract_h1(content))
        .or_else(|| first_line_title(content))
        .unwrap_or_else(|| "untitled".to_string());

    let slug = slugify(&title);
    let mut filename = format!("{slug}.md");
    let mut n = 2;
    while root.join(&filename).exists() {
        filename = format!("{slug}-{n}.md");
        n += 1;
    }

    let full = root.join(&filename);
    std::fs::write(&full, content).with_context(|| format!("write {}", full.display()))?;

    Ok(CreatedNote { path: filename, title })
}

/// Most recently modified notes, newest first.
///
/// Prefers the snapshot's `docs` table (it knows title/doc_type); falls
/// back to walking the filesystem when no snapshot exists yet.
pub fn list_notes(cfg: &Config, limit: usize) -> Result<Vec<DocMeta>> {
    if cfg.snapshot_path.is_file() {
        if let Ok(conn) = db::open_snapshot(&cfg.snapshot_path) {
            let mut stmt = conn.prepare(
                "SELECT path, title, doc_type, mtime, size_bytes
                 FROM docs ORDER BY mtime DESC LIMIT ?",
            )?;
            let rows = stmt.query_map([limit as i64], |r| {
                Ok(DocMeta {
                    path: r.get(0)?,
                    title: r.get(1)?,
                    doc_type: r.get(2)?,
                    mtime: r.get(3)?,
                    size_bytes: r.get(4)?,
                })
            })?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            return Ok(out);
        }
    }

    // Fallback: walk the filesystem. No title/doc_type metadata here
    // beyond the filename stem.
    if !cfg.notes_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries = scanner::scan(&cfg.notes_dir);
    entries.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    entries.truncate(limit);
    Ok(entries
        .into_iter()
        .map(|e| DocMeta {
            path: relative_path(&cfg.notes_dir, &e.path),
            title: e
                .path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned()),
            doc_type: None,
            mtime: e.mtime,
            size_bytes: e.size,
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Canonicalized notes root. `create` also mkdir -p's it (write paths).
fn notes_root(cfg: &Config, create: bool) -> Result<PathBuf> {
    if create {
        std::fs::create_dir_all(&cfg.notes_dir)
            .with_context(|| format!("create {}", cfg.notes_dir.display()))?;
    }
    cfg.notes_dir
        .canonicalize()
        .with_context(|| format!("notes dir not found: {}", cfg.notes_dir.display()))
}

/// Lexical validation of a caller-supplied relative path: relative, no
/// `..`/root components, `.md` extension.
fn validated_rel(rel: &str) -> Result<PathBuf> {
    if rel.trim().is_empty() {
        bail!("empty path");
    }
    let p = Path::new(rel);
    if p.is_absolute() {
        bail!("path must be relative to the notes dir: {rel}");
    }
    for c in p.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => bail!("path may not contain `..` or root components: {rel}"),
        }
    }
    let is_md = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md"))
        .unwrap_or(false);
    if !is_md {
        bail!("only .md files are allowed: {rel}");
    }
    Ok(p.to_path_buf())
}

fn file_mtime(p: &Path) -> Result<i64> {
    Ok(std::fs::metadata(p)?
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0))
}

fn extract_h1(content: &str) -> Option<String> {
    content
        .lines()
        .find_map(|l| l.strip_prefix("# ").map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
}

/// First non-empty line, markdown heading markers stripped, truncated.
fn first_line_title(content: &str) -> Option<String> {
    let line = content.lines().find(|l| !l.trim().is_empty())?;
    let line = line.trim().trim_start_matches('#').trim();
    if line.is_empty() {
        return None;
    }
    let truncated: String = line.chars().take(60).collect();
    Some(truncated)
}

/// Filename slug: keeps alphanumerics in any script (CJK included),
/// `-`/`_`/`.`; whitespace becomes `-`; everything else is dropped.
/// Runs of `-` collapse; leading/trailing `-`/`.` are trimmed; capped
/// at 80 chars. Falls back to "untitled".
fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.trim().chars() {
        if ch.is_whitespace() {
            out.push('-');
        } else if ch.is_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
        }
        // else: drop punctuation, slashes, emoji, control chars, …
    }
    // Collapse repeated '-'.
    let mut collapsed = String::with_capacity(out.len());
    let mut last_dash = false;
    for ch in out.chars() {
        if ch == '-' {
            if !last_dash {
                collapsed.push('-');
            }
            last_dash = true;
        } else {
            collapsed.push(ch);
            last_dash = false;
        }
    }
    let trimmed = collapsed.trim_matches(|c| c == '-' || c == '.').to_string();
    if trimmed.is_empty() {
        return "untitled".to_string();
    }
    trimmed.chars().take(80).collect()
}

#[cfg(test)]
mod tests {
    use super::{slugify, validated_rel};

    #[test]
    fn slug_basics() {
        assert_eq!(slugify("Hello World"), "Hello-World");
        assert_eq!(slugify("Recipe: Braised-Pork Belly"), "Recipe-Braised-Pork-Belly");
        assert_eq!(slugify("a/b\\c:d*e"), "abcde");
        assert_eq!(slugify("  --- "), "untitled");
        assert_eq!(slugify("🎉🎉"), "untitled");
    }

    #[test]
    fn rel_validation() {
        assert!(validated_rel("a.md").is_ok());
        assert!(validated_rel("dir/b.md").is_ok());
        assert!(validated_rel("../x.md").is_err());
        assert!(validated_rel("/abs.md").is_err());
        assert!(validated_rel("a.txt").is_err());
        assert!(validated_rel("dir/../../x.md").is_err());
        assert!(validated_rel("").is_err());
    }
}
