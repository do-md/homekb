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

/// If the snapshot at `snapshot_path` has a strictly higher `generation`
/// than the local `live_path`, atomically replace the local copy.
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
