//! Two-way movement of the SQLite database between
//!   - the local live database (`live.db`, WAL, mutable), and
//!   - the (possibly cloud-synced) read-only snapshot (`<root>/index/index.db`).
//!
//! `import_if_newer` is called at the start of every compile run to
//! pull a more recent snapshot (e.g. compiled on another machine) onto
//! the local machine. `export` is called at the end of every successful
//! compile run.

use anyhow::{Context, Result};
use rusqlite::Connection;
use std::path::Path;

use super::vec_ext;

/// Read a single key from `index_meta` of the database at `path`.
/// Returns `Ok(None)` if the file is missing, the table is missing, or the row is absent.
fn read_meta(path: &Path, key: &str) -> Result<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }
    vec_ext::ensure_registered();
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .with_context(|| format!("open {}", path.display()))?;

    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='index_meta'",
            [],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !exists {
        return Ok(None);
    }
    let val: Option<String> = conn
        .query_row(
            "SELECT value FROM index_meta WHERE key = ?",
            [key],
            |r| r.get::<_, String>(0),
        )
        .ok();
    Ok(val)
}

fn read_generation(path: &Path) -> Result<i64> {
    Ok(read_meta(path, "generation")?
        .and_then(|s| s.parse().ok())
        .unwrap_or(-1))
}

/// The embedding identity (provider/model/dim) that defines a db's vector
/// space. Two dbs are cross-space if any of the three differ.
fn embedding_identity(path: &Path) -> Result<(Option<String>, Option<String>, Option<String>)> {
    Ok((
        read_meta(path, "embedding_provider")?,
        read_meta(path, "embedding_model")?,
        read_meta(path, "embedding_dim")?,
    ))
}

/// If the snapshot at `snapshot_path` has a strictly higher `generation`
/// than the local `live_path` **and shares its vector space**, atomically
/// replace the local copy.
///
/// The vector-space guard matters after `rebuild --force` switches the
/// embedding model: the local db is reset to the new model at generation 0,
/// while the old snapshot still sits at a higher generation. Without the guard
/// the compile would re-adopt the stale (wrong-model) snapshot and silently
/// undo the rebuild. A local db with no embedding identity yet (a fresh
/// machine) still adopts the snapshot — that is the intended multi-machine
/// bootstrap.
///
/// Returns true if a sync happened.
pub fn import_if_newer(live_path: &Path, snapshot_path: &Path) -> Result<bool> {
    let local_gen = read_generation(live_path).unwrap_or(-1);
    let snap_gen = read_generation(snapshot_path).unwrap_or(-1);

    if snap_gen < 0 {
        // No snapshot exists yet; this is the first machine to compile.
        return Ok(false);
    }
    if snap_gen <= local_gen {
        // Local is at least as fresh.
        return Ok(false);
    }

    // Cross-vector-space guard: only skip when the *local* db already has an
    // embedding identity that disagrees with the snapshot (a rebuild to a new
    // model). A fresh local db (no model meta) adopts the snapshot as usual.
    let (l_provider, l_model, l_dim) = embedding_identity(live_path)?;
    if l_model.is_some() || l_dim.is_some() {
        let (s_provider, s_model, s_dim) = embedding_identity(snapshot_path)?;
        if (l_provider, l_model, l_dim) != (s_provider, s_model, s_dim) {
            tracing::warn!(
                "snapshot (gen {}) is from a different embedding model than the local db; \
                 not adopting it (an embedding switch is in progress — the next compile \
                 exports a snapshot in the new space)",
                snap_gen
            );
            return Ok(false);
        }
    }

    tracing::info!(
        from = snap_gen,
        to = local_gen,
        "Adopting snapshot (gen {} > local {})",
        snap_gen,
        local_gen
    );

    // Ensure parent dir exists.
    if let Some(parent) = live_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Defensively remove WAL/SHM siblings of the live db so we don't
    // mix journal state from an older db file with the new main file.
    for suffix in ["-wal", "-shm"] {
        let mut p = live_path.to_path_buf();
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        p.set_file_name(format!("{name}{suffix}"));
        let _ = std::fs::remove_file(p);
    }

    // Stage to a sibling .tmp then rename — atomic on POSIX.
    let tmp = live_path.with_extension("tmp.db");
    std::fs::copy(snapshot_path, &tmp)
        .with_context(|| format!("copy {} → {}", snapshot_path.display(), tmp.display()))?;
    std::fs::rename(&tmp, live_path)
        .with_context(|| format!("rename {} → {}", tmp.display(), live_path.display()))?;

    Ok(true)
}

/// Export the current live database to a snapshot file via SQLite's
/// online backup API. The destination is staged to a `.tmp` sibling and
/// atomically renamed into place, so readers on other machines never
/// observe a partially-written snapshot.
pub fn export(live: &Connection, snapshot_path: &Path) -> Result<()> {
    if let Some(parent) = snapshot_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let tmp = snapshot_path.with_extension("tmp.db");
    let _ = std::fs::remove_file(&tmp);

    vec_ext::ensure_registered();
    let mut dst = Connection::open(&tmp)
        .with_context(|| format!("open snapshot tmp {}", tmp.display()))?;

    {
        let backup = rusqlite::backup::Backup::new(live, &mut dst)?;
        backup.run_to_completion(200, std::time::Duration::from_millis(0), None)?;
    }
    drop(dst);

    std::fs::rename(&tmp, snapshot_path)
        .with_context(|| format!("rename {} → {}", tmp.display(), snapshot_path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(path: &Path, generation: i64, provider: &str, model: &str, dim: usize) {
        vec_ext::ensure_registered();
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS index_meta(key TEXT PRIMARY KEY, value TEXT);",
        )
        .unwrap();
        for (k, v) in [
            ("generation", generation.to_string()),
            ("embedding_provider", provider.into()),
            ("embedding_model", model.into()),
            ("embedding_dim", dim.to_string()),
        ] {
            conn.execute(
                "INSERT OR REPLACE INTO index_meta(key,value) VALUES(?,?)",
                rusqlite::params![k, v],
            )
            .unwrap();
        }
    }

    // Regression: after a rebuild switches the model, a higher-generation
    // snapshot from the *old* model must NOT be re-adopted — otherwise the
    // rebuild is silently undone.
    #[test]
    fn import_skips_cross_model_snapshot() {
        let dir = std::env::temp_dir().join(format!("homekb-import-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let live = dir.join("live.db");
        let snap = dir.join("index.db");

        // Live db just rebuilt to gemini/3072 at gen 0; old snapshot is
        // openai/1536 at a much higher generation.
        seed(&live, 0, "gemini", "gemini-embedding-001", 3072);
        seed(&snap, 37, "openai", "text-embedding-3-small", 1536);
        assert!(!import_if_newer(&live, &snap).unwrap(), "must not adopt cross-model snapshot");

        // Same model, higher generation (normal multi-machine sync) → adopt.
        seed(&snap, 5, "gemini", "gemini-embedding-001", 3072);
        assert!(import_if_newer(&live, &snap).unwrap(), "same-model newer snapshot should sync");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
