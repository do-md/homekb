//! Filesystem ↔ database reconciliation.
//!
//! Steps:
//!   1. enumerate fs (.md files)
//!   2. load db rows
//!   3. classify created / deleted / candidate
//!   4. confirm candidates by content hash
//!   5. rename detection by content hash
//!   6. recovery: rows with index_state != ok
//!   7. emit ChangeSet

use anyhow::Result;
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::hasher::sha256_hex;
use crate::scanner::FsEntry;
use crate::types::{ChangeSet, DocRow, IndexState};

pub fn build_changeset(
    conn: &mut Connection,
    notes_root: &Path,
    fs_entries: &[FsEntry],
) -> Result<ChangeSet> {
    let db_rows = load_doc_rows(conn, notes_root)?;
    let mut by_path: HashMap<PathBuf, &DocRow> = db_rows.iter().map(|r| (r.path.clone(), r)).collect();

    let mut cs = ChangeSet::default();

    // Pass 1: walk fs entries, classify as created / candidate / recovery / unchanged.
    for entry in fs_entries {
        match by_path.get(&entry.path) {
            None => cs.created.push(entry.path.clone()),
            Some(row) => {
                if row.index_state != IndexState::Ok {
                    cs.recovery.push(entry.path.clone());
                } else if entry.mtime != row.mtime || entry.size != row.size_bytes {
                    // Cheap heuristic mismatch — confirm via content hash.
                    let content = match std::fs::read(&entry.path) {
                        Ok(v) => v,
                        Err(err) => {
                            tracing::warn!("read failed for {}: {}", entry.path.display(), err);
                            continue;
                        }
                    };
                    let h = sha256_hex(&content);
                    if h != row.content_hash {
                        cs.updated.push(entry.path.clone());
                    } else {
                        // mtime/size drifted (touch, sync, etc.) but content is identical.
                        update_mtime_only(conn, row.id, entry.mtime, entry.size)?;
                    }
                }
            }
        }
        by_path.remove(&entry.path);
    }

    // Pass 2: anything left in by_path was deleted from disk.
    for path in by_path.keys() {
        cs.deleted.push(path.clone());
    }

    // Pass 3: rename detection. For each `created` path compute its hash;
    // if some `deleted` row has the same content_hash, treat as rename.
    if !cs.created.is_empty() && !cs.deleted.is_empty() {
        let deleted_hash_to_path: HashMap<String, PathBuf> = db_rows
            .iter()
            .filter(|r| cs.deleted.iter().any(|p| p == &r.path))
            .map(|r| (r.content_hash.clone(), r.path.clone()))
            .collect();

        let mut still_created = Vec::new();
        let mut consumed_deletes = Vec::new();

        for new_path in cs.created.drain(..) {
            let bytes = match std::fs::read(&new_path) {
                Ok(b) => b,
                Err(_) => { still_created.push(new_path); continue; }
            };
            let h = sha256_hex(&bytes);
            match deleted_hash_to_path.get(&h) {
                Some(old) if !consumed_deletes.contains(old) => {
                    cs.renamed.push((old.clone(), new_path));
                    consumed_deletes.push(old.clone());
                }
                _ => still_created.push(new_path),
            }
        }
        cs.created = still_created;
        cs.deleted.retain(|p| !consumed_deletes.contains(p));
    }

    Ok(cs)
}

fn load_doc_rows(conn: &Connection, notes_root: &Path) -> Result<Vec<DocRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, path, content_hash, mtime, size_bytes, index_state FROM docs",
    )?;
    let rows = stmt.query_map([], |r| {
        let rel: String = r.get(1)?;
        Ok(DocRow {
            id: r.get(0)?,
            path: notes_root.join(rel),
            content_hash: r.get(2)?,
            mtime: r.get(3)?,
            size_bytes: r.get(4)?,
            index_state: IndexState::from_str(&r.get::<_, String>(5)?),
        })
    })?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

fn update_mtime_only(conn: &Connection, doc_id: i64, mtime: i64, size: i64) -> Result<()> {
    conn.execute(
        "UPDATE docs SET mtime = ?, size_bytes = ? WHERE id = ?",
        rusqlite::params![mtime, size, doc_id],
    )?;
    Ok(())
}

/// Apply a rename directly (no embeddings needed).
pub fn apply_rename(
    conn: &Connection,
    notes_root: &Path,
    old: &Path,
    new: &Path,
) -> Result<()> {
    let new_rel = crate::config::relative_path(notes_root, new);
    let old_rel = crate::config::relative_path(notes_root, old);
    conn.execute(
        "UPDATE docs SET path = ? WHERE path = ?",
        rusqlite::params![new_rel, old_rel],
    )?;
    Ok(())
}

pub fn apply_delete(conn: &Connection, notes_root: &Path, path: &Path) -> Result<()> {
    let rel = crate::config::relative_path(notes_root, path);
    conn.execute("DELETE FROM docs WHERE path = ?", rusqlite::params![rel])?;
    Ok(())
}
