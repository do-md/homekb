//! Database access.
//!
//! Two openers:
//!   - [`open_live`]: the mutable WAL working db used by the compiler.
//!   - [`open_snapshot`]: strict read-only access to the exported snapshot,
//!     used by search / status / list. If the snapshot is missing or has the
//!     wrong schema we error out rather than returning an empty result set,
//!     so callers can distinguish "index unavailable" from "no matches".

pub mod snapshot;
pub mod vec_ext;

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OpenFlags};
use std::path::Path;

const SCHEMA: &str = include_str!("schema.sql");
const SCHEMA_VERSION: &str = "3";

/// Open or create the live database, run migrations, ensure vec0 tables
/// exist at the configured dimension, and verify model coherence.
///
/// The `[embedding]` endpoint's provider / model / dim are checked against
/// any previously stored values; a mismatch returns an error so the user can
/// decide whether to `rebuild --force` (switching provider or model changes
/// the vector space, exactly like a model change always did).
///
/// **Empty-index exception** (docs "Compilation pipeline"): when the db has
/// zero indexed docs there is no vector space to protect, so a coherence
/// mismatch auto-resets the db to the new config instead of bailing. This
/// unwedges the fresh-setup trap: the resident compile's first cycle stamps
/// the brand-new empty db with the *default* (openai) config before the user
/// has configured anything; without the exception, picking a different
/// provider in Settings would block every subsequent compile until a manual
/// `rebuild --force`.
pub fn open_live(
    path: &Path,
    embedding: &crate::config::EmbeddingEndpoint,
    summarizer_model: &str,
) -> Result<Connection> {
    let mut conn = open_live_raw(path, embedding.dim)?;
    if let Err(err) = verify_or_seed_meta(&conn, embedding, summarizer_model) {
        if !index_is_empty(&conn)? {
            return Err(err);
        }
        tracing::info!(
            "index is empty — auto-resetting to the current embedding config \
             instead of requiring `rebuild --force` ({err:#})"
        );
        drop(conn);
        rebuild_reset(path, embedding, summarizer_model)?;
        conn = open_live_raw(path, embedding.dim)?;
        verify_or_seed_meta(&conn, embedding, summarizer_model)?;
    }

    // Indexes that reference columns added by migrations live here,
    // not in schema.sql, so they only run after migration guarantees
    // the column exists.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_docs_type ON docs(doc_type) WHERE doc_type IS NOT NULL",
        [],
    )?;

    Ok(conn)
}

/// Open the live db, apply the base schema, and ensure the vec0 tables exist
/// at `dim` — **without** the model/dim coherence check. `open_live` layers
/// [`verify_or_seed_meta`] on top; `rebuild_reset` deliberately skips it so a
/// model/provider switch (which would otherwise bail) can wipe and re-seed.
fn open_live_raw(path: &Path, dim: usize) -> Result<Connection> {
    vec_ext::ensure_registered();

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let conn = Connection::open(path)
        .with_context(|| format!("open live db {}", path.display()))?;

    // Pragmas: WAL for concurrency, foreign keys ON for cascade.
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous  = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        "#,
    )?;

    // Apply (idempotent) schema for regular tables.
    conn.execute_batch(SCHEMA)?;

    // Virtual tables: dimension is a literal in the DDL, so we build it dynamically.
    conn.execute_batch(&format!(
        r#"
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_docs   USING vec0(embedding FLOAT[{dim}]);
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding FLOAT[{dim}]);
        "#,
    ))?;

    Ok(conn)
}

/// Hard reset for `rebuild --force`: drop every row and **drop + recreate the
/// vec0 tables at the new dimension** (a `DELETE` can't change a vec0 table's
/// fixed dimension, so an embedding-model switch to a different dim needs the
/// tables rebuilt), then overwrite the embedding/summarizer meta to the new
/// config so the next `open_live` coherence check passes. Skips the coherence
/// check itself — it is the one place allowed to cross vector spaces.
pub fn rebuild_reset(
    path: &Path,
    embedding: &crate::config::EmbeddingEndpoint,
    summarizer_model: &str,
) -> Result<()> {
    // Open with the *current on-disk* schema (dim doesn't matter — we drop the
    // vec tables next), so this works even when the stored dim differs.
    let conn = open_live_raw(path, embedding.dim)?;
    conn.execute_batch(
        r#"
        DELETE FROM chunks;
        DELETE FROM docs;
        DELETE FROM failures;
        DROP TABLE IF EXISTS vec_docs;
        DROP TABLE IF EXISTS vec_chunks;
        "#,
    )?;
    conn.execute_batch(&format!(
        r#"
        CREATE VIRTUAL TABLE vec_docs   USING vec0(embedding FLOAT[{dim}]);
        CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding FLOAT[{dim}]);
        "#,
        dim = embedding.dim,
    ))?;
    write_meta(&conn, "schema_version", SCHEMA_VERSION)?;
    write_meta(&conn, "embedding_provider", &embedding.provider)?;
    write_meta(&conn, "embedding_base_url", &embedding.base_url)?;
    write_meta(&conn, "embedding_model", &embedding.model)?;
    write_meta(&conn, "embedding_dim", &embedding.dim.to_string())?;
    write_meta(&conn, "summarizer_model", summarizer_model)?;
    write_meta(&conn, "generation", "0")?;
    Ok(())
}

/// Open the exported snapshot read-only. Strict: missing file or foreign
/// schema is an error.
pub fn open_snapshot(path: &Path) -> Result<Connection> {
    if !path.exists() {
        bail!(
            "snapshot not found at {}. Run `homekb reindex` first.",
            path.display()
        );
    }

    vec_ext::ensure_registered();

    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("open snapshot {}", path.display()))?;

    // Verify it really is our schema by checking for the vec0 virtual table.
    let has_vec_chunks: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_chunks'",
            [],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if !has_vec_chunks {
        bail!(
            "snapshot at {} does not look like a homekb index (missing vec_chunks)",
            path.display()
        );
    }

    Ok(conn)
}

/// Metadata a search needs from the snapshot before embedding the query.
#[derive(Debug, Clone)]
pub struct SnapshotMeta {
    /// Provider that produced the index vectors ("openai" when the snapshot
    /// predates provider support).
    pub embedding_provider: String,
    /// Base URL recorded at compile time (None on pre-provider snapshots).
    pub embedding_base_url: Option<String>,
    pub embedding_model: String,
    pub embedding_dim: usize,
    pub generation: i64,
}

pub fn read_snapshot_meta(conn: &Connection) -> Result<SnapshotMeta> {
    let embedding_provider =
        read_meta(conn, "embedding_provider")?.unwrap_or_else(|| "openai".into());
    let embedding_base_url = read_meta(conn, "embedding_base_url")?;
    let embedding_model = read_meta(conn, "embedding_model")?
        .context("snapshot missing embedding_model metadata")?;
    let embedding_dim: usize = read_meta(conn, "embedding_dim")?
        .context("snapshot missing embedding_dim metadata")?
        .parse()
        .context("embedding_dim is not a valid integer")?;
    let generation: i64 = read_meta(conn, "generation")?
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    Ok(SnapshotMeta {
        embedding_provider,
        embedding_base_url,
        embedding_model,
        embedding_dim,
        generation,
    })
}

/// Zero indexed docs = nothing embedded = no vector space worth protecting.
/// (Orphan vec rows without a doc cannot exist through the pipeline; even if
/// present from a crash, they are garbage a reset is allowed to drop.)
fn index_is_empty(conn: &Connection) -> Result<bool> {
    let docs: i64 = conn.query_row("SELECT COUNT(*) FROM docs", [], |r| r.get(0))?;
    Ok(docs == 0)
}

fn verify_or_seed_meta(
    conn: &Connection,
    embedding: &crate::config::EmbeddingEndpoint,
    summarizer_model: &str,
) -> Result<()> {
    let embedding_model = &embedding.model;
    let embedding_dim = embedding.dim;
    let stored_version = read_meta(conn, "schema_version")?;
    match stored_version.as_deref() {
        None => write_meta(conn, "schema_version", SCHEMA_VERSION)?,
        Some("1") => {
            // v1 → v2: add doc_type column (NULL for existing rows;
            // backfilled lazily by the pipeline next time it sees them).
            migrate_v1_to_v2(conn)?;
            migrate_v2_to_v3(conn)?;
            write_meta(conn, "schema_version", SCHEMA_VERSION)?;
        }
        Some("2") => {
            // v2 → v3: add suggested_question column (NULL for existing
            // rows; backfilled lazily, same mechanism as doc_type).
            migrate_v2_to_v3(conn)?;
            write_meta(conn, "schema_version", SCHEMA_VERSION)?;
        }
        Some(v) if v == SCHEMA_VERSION => {}
        Some(other) => bail!(
            "schema_version mismatch: db has {other}, binary expects {SCHEMA_VERSION}. \
             Run `homekb rebuild --force`."
        ),
    }

    // Provider participates in vector-space identity exactly like the model:
    // a pre-provider db (no key stored) is treated as "openai".
    let prev_provider = read_meta(conn, "embedding_provider")?.unwrap_or_else(|| "openai".into());
    if read_meta(conn, "embedding_model")?.is_some() && prev_provider != embedding.provider {
        bail!(
            "embedding provider changed (db: {prev_provider}, config: {}). \
             Run `homekb rebuild --force` to reindex with the new provider.",
            embedding.provider
        );
    }
    write_meta(conn, "embedding_provider", &embedding.provider)?;
    // Base URL is informational (needed at query time for custom providers).
    write_meta(conn, "embedding_base_url", &embedding.base_url)?;

    if let Some(prev) = read_meta(conn, "embedding_model")? {
        if &prev != embedding_model {
            bail!(
                "embedding_model changed (db: {prev}, config: {embedding_model}). \
                 Run `homekb rebuild --force` to reindex with the new model."
            );
        }
    } else {
        write_meta(conn, "embedding_model", embedding_model)?;
    }

    if let Some(prev) = read_meta(conn, "embedding_dim")? {
        let prev_n: usize = prev.parse().unwrap_or(0);
        if prev_n != embedding_dim {
            bail!(
                "embedding_dim changed (db: {prev_n}, config: {embedding_dim}). \
                 Run `homekb rebuild --force`."
            );
        }
    } else {
        write_meta(conn, "embedding_dim", &embedding_dim.to_string())?;
    }

    // summarizer_model is informational only — different models for summaries
    // do not require a full reindex, just (optionally) a summary refresh.
    write_meta(conn, "summarizer_model", summarizer_model)?;

    if read_meta(conn, "generation")?.is_none() {
        write_meta(conn, "generation", "0")?;
    }
    Ok(())
}

pub fn read_meta(conn: &Connection, key: &str) -> Result<Option<String>> {
    let val: Option<String> = conn
        .query_row(
            "SELECT value FROM index_meta WHERE key = ?",
            [key],
            |r| r.get(0),
        )
        .ok();
    Ok(val)
}

pub fn write_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO index_meta(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )?;
    Ok(())
}

pub fn current_generation(conn: &Connection) -> Result<i64> {
    Ok(read_meta(conn, "generation")?
        .and_then(|s| s.parse().ok())
        .unwrap_or(0))
}

/// Bump generation by 1 and stamp host/time.
pub fn bump_generation(conn: &Connection) -> Result<i64> {
    let next = current_generation(conn)? + 1;
    write_meta(conn, "generation", &next.to_string())?;

    let host = hostname();
    write_meta(conn, "last_compile_host", &host)?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    write_meta(conn, "last_compile_at", &ts.to_string())?;
    Ok(next)
}

fn hostname() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| std::process::Command::new("hostname")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string()))
        .unwrap_or_else(|| "unknown".to_string())
}

fn migrate_v1_to_v2(conn: &Connection) -> Result<()> {
    // ALTER TABLE is idempotent if we check first — SQLite errors on
    // duplicate column add but lets us inspect the table info cheaply.
    let exists: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('docs') WHERE name = 'doc_type'")?
        .exists([])?;
    if !exists {
        conn.execute("ALTER TABLE docs ADD COLUMN doc_type TEXT", [])?;
    }
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_docs_type ON docs(doc_type) WHERE doc_type IS NOT NULL",
        [],
    )?;
    tracing::info!("migrated schema v1 → v2 (added docs.doc_type)");
    Ok(())
}

fn migrate_v2_to_v3(conn: &Connection) -> Result<()> {
    let exists: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('docs') WHERE name = 'suggested_question'")?
        .exists([])?;
    if !exists {
        conn.execute("ALTER TABLE docs ADD COLUMN suggested_question TEXT", [])?;
    }
    tracing::info!("migrated schema v2 → v3 (added docs.suggested_question)");
    Ok(())
}

/// Vocabulary of doc_types known to the index, ordered by descending count.
/// Caller passes this to the categorizer so the LLM prefers existing labels.
pub fn doc_type_vocab(conn: &Connection) -> Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT doc_type, COUNT(*) AS c FROM docs
         WHERE doc_type IS NOT NULL
         GROUP BY doc_type
         ORDER BY c DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::EmbeddingEndpoint;

    fn ep(provider: &str, model: &str, dim: usize) -> EmbeddingEndpoint {
        EmbeddingEndpoint {
            provider: provider.into(),
            base_url: "http://localhost/v1".into(),
            api_key: None,
            model: model.into(),
            dim,
        }
    }

    fn insert_vec(conn: &Connection, table: &str, rowid: i64, dim: usize) -> rusqlite::Result<()> {
        let bytes: Vec<u8> = (0..dim).flat_map(|_| 0.1f32.to_le_bytes()).collect();
        conn.execute(
            &format!("INSERT INTO {table}(rowid, embedding) VALUES (?, ?)"),
            rusqlite::params![rowid, bytes],
        )
        .map(|_| ())
    }

    // Regression: `rebuild --force` must survive an embedding-model switch that
    // changes the vector dimension. Before the fix, the coherence check bailed
    // and the vec0 tables kept their old (wrong) dimension.
    #[test]
    fn rebuild_reset_crosses_vector_spaces() {
        let dir = std::env::temp_dir().join(format!("homekb-rebuild-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let live = dir.join("live.db");

        // Seed an openai/1536 index; a 1536-dim vector fits.
        let conn = open_live(&live, &ep("openai", "text-embedding-3-small", 1536), "gpt-4o-mini").unwrap();
        assert_eq!(read_meta(&conn, "embedding_dim").unwrap().as_deref(), Some("1536"));
        insert_vec(&conn, "vec_chunks", 1, 1536).unwrap();
        drop(conn);

        // Switch to gemini/3072 — must not bail, and must rebuild the vec tables.
        rebuild_reset(&live, &ep("gemini", "gemini-embedding-001", 3072), "gpt-4o-mini").unwrap();

        let conn = open_live(&live, &ep("gemini", "gemini-embedding-001", 3072), "gpt-4o-mini").unwrap();
        assert_eq!(read_meta(&conn, "embedding_dim").unwrap().as_deref(), Some("3072"));
        assert_eq!(read_meta(&conn, "embedding_provider").unwrap().as_deref(), Some("gemini"));
        // Rows were dropped, and the table is now 3072-dim.
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM vec_chunks", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        insert_vec(&conn, "vec_chunks", 1, 3072).unwrap();
        assert!(insert_vec(&conn, "vec_docs", 1, 1536).is_err(), "old dim must be rejected");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn insert_doc(conn: &Connection, path: &str) {
        conn.execute(
            "INSERT INTO docs(path, content_hash, size_bytes, mtime, indexed_at)
             VALUES (?, 'hash', 1, 0, 0)",
            [path],
        )
        .unwrap();
    }

    // The fresh-setup trap: the resident compile's first cycle stamps the
    // brand-new EMPTY db with the default (openai) config before the user has
    // configured any provider. Switching to another provider must then
    // auto-reset instead of demanding `rebuild --force` — an empty index has
    // no vector space to protect.
    #[test]
    fn empty_index_auto_resets_on_provider_switch() {
        let dir = std::env::temp_dir().join(format!("homekb-emptyreset-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let live = dir.join("live.db");

        // First open with defaults stamps openai/1536 onto the empty db.
        let conn =
            open_live(&live, &ep("openai", "text-embedding-3-small", 1536), "gpt-4o-mini").unwrap();
        assert_eq!(read_meta(&conn, "embedding_provider").unwrap().as_deref(), Some("openai"));
        drop(conn);

        // User configures gemini: open must succeed and re-stamp, vec tables
        // rebuilt at the new dimension.
        let conn =
            open_live(&live, &ep("gemini", "gemini-embedding-001", 3072), "gpt-4o-mini").unwrap();
        assert_eq!(read_meta(&conn, "embedding_provider").unwrap().as_deref(), Some("gemini"));
        assert_eq!(read_meta(&conn, "embedding_dim").unwrap().as_deref(), Some("3072"));
        insert_vec(&conn, "vec_chunks", 1, 3072).unwrap();
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // A non-empty index keeps the strict guard: crossing vector spaces still
    // requires an explicit `rebuild --force`.
    #[test]
    fn non_empty_index_still_requires_rebuild_force() {
        let dir = std::env::temp_dir().join(format!("homekb-nonempty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let live = dir.join("live.db");

        let conn =
            open_live(&live, &ep("openai", "text-embedding-3-small", 1536), "gpt-4o-mini").unwrap();
        insert_doc(&conn, "a.md");
        drop(conn);

        let err = open_live(&live, &ep("gemini", "gemini-embedding-001", 3072), "gpt-4o-mini")
            .expect_err("provider switch on a non-empty index must bail");
        assert!(
            format!("{err:#}").contains("rebuild --force"),
            "error should point at rebuild --force, got: {err:#}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
