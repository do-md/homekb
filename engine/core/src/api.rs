//! Public engine API.
//!
//! Result shapes serialize with camelCase field names and match the
//! "RPC 方法" table in docs/ARCHITECTURE.md, so CLI `--json`, the local
//! MCP server and the relay tunnel all speak the exact same schema.

use anyhow::{Context, Result, bail};
use fs2::FileExt;
use rusqlite::Connection;
use serde::Serialize;
use std::fs::OpenOptions;
use std::path::Path;

use crate::ai::{Categorizer, Embedder, Summarizer, embedder};
use crate::config::Config;
use crate::search as retrieval;
use crate::search::{RawHit, SearchParams};
use crate::{db, pipeline, reconciler, scanner};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/// Outcome of one incremental compile run.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReindexReport {
    /// Total .md files seen on disk.
    pub scanned: usize,
    pub created: usize,
    pub updated: usize,
    pub deleted: usize,
    pub renamed: usize,
    pub recovered: usize,
    /// Docs re-categorized in place (doc_type backfill).
    pub backfilled: usize,
    /// Docs whose processing failed (recorded in the `failures` table).
    pub failed: usize,
    /// Index generation after this run.
    pub generation: i64,
    pub duration_ms: u64,
}

/// Options for [`search`].
#[derive(Debug, Clone)]
pub struct SearchOptions {
    pub query: String,
    /// Maximum results after fusion (and after full-doc collapse).
    pub limit: usize,
    /// Restrict retrieval to docs with this doc_type. Strict: an unknown
    /// type is an error, listing the available vocabulary.
    pub doc_type: Option<String>,
    /// Return one entry per unique document with FULL file contents
    /// instead of chunks.
    pub full: bool,
    /// Drop results whose embedding distance exceeds this threshold.
    /// 0 = no filter.
    pub max_distance: f64,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            query: String::new(),
            limit: 10,
            doc_type: None,
            full: false,
            max_distance: 0.0,
        }
    }
}

/// One search result. `kind` is `"chunk" | "doc" | "doc_full"`.
/// For `doc` hits, `content` carries the document summary; for `chunk`
/// the chunk text; for `doc_full` the entire file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub kind: String,
    pub path: String,
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading_path: Option<String>,
    pub content: String,
    pub score: f64,
    pub mtime: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutput {
    pub query: String,
    pub results: Vec<Hit>,
}

/// Index status, read from the snapshot.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    /// False when no snapshot exists yet (all other fields zero/empty).
    pub available: bool,
    pub generation: i64,
    pub docs: i64,
    pub chunks: i64,
    pub chunks_with_vectors: i64,
    pub pending: i64,
    pub failures: i64,
    /// Unix seconds of the last compile; 0 if unknown.
    pub last_compile_at: i64,
    pub last_compile_host: String,
    pub embedding_model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeCount {
    pub doc_type: String,
    pub count: i64,
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

/// Run one incremental compile: scan → reconcile → chunk/embed/summarize/
/// classify → bump generation → export snapshot atomically.
///
/// `quiet` suppresses per-step info logging (errors still log).
pub async fn reindex(cfg: &Config, quiet: bool) -> Result<ReindexReport> {
    let started = std::time::Instant::now();

    if !cfg.notes_dir.is_dir() {
        bail!(
            "notes directory does not exist: {} (run `homekb init` first)",
            cfg.notes_dir.display()
        );
    }

    let _lock = acquire_lock(&cfg.lock_path())?;

    let adopted = db::snapshot::import_if_newer(&cfg.live_db, &cfg.snapshot_path)?;
    if adopted && !quiet {
        tracing::info!("adopted newer snapshot from {}", cfg.snapshot_path.display());
    }

    let mut conn = db::open_live(
        &cfg.live_db,
        &cfg.embedding_model,
        cfg.embedding_dim,
        &cfg.summarizer_model,
    )?;

    let fs_entries = scanner::scan(&cfg.notes_dir);
    if !quiet {
        tracing::info!(
            "scanned {} files under {}",
            fs_entries.len(),
            cfg.notes_dir.display()
        );
    }

    let cs = reconciler::build_changeset(&mut conn, &cfg.notes_dir, &fs_entries)?;
    if !quiet {
        tracing::info!(
            "changeset: {} created, {} updated, {} deleted, {} renamed, {} recovery",
            cs.created.len(),
            cs.updated.len(),
            cs.deleted.len(),
            cs.renamed.len(),
            cs.recovery.len(),
        );
    }

    let mut report = ReindexReport {
        scanned: fs_entries.len(),
        created: cs.created.len(),
        updated: cs.updated.len(),
        deleted: cs.deleted.len(),
        renamed: cs.renamed.len(),
        recovered: cs.recovery.len(),
        ..Default::default()
    };

    let backfill_needed = doc_type_backfill_count(&conn)? > 0;
    if cs.is_empty() && !backfill_needed {
        if !quiet {
            tracing::info!("nothing to do");
        }
        // Make sure a snapshot exists even on a no-op run (e.g. the file
        // was deleted, or the very first run over an empty notes dir),
        // so status/search have something to open.
        if !cfg.snapshot_path.exists() {
            db::snapshot::export(&conn, &cfg.snapshot_path)?;
        }
        report.generation = db::current_generation(&conn)?;
        report.duration_ms = started.elapsed().as_millis() as u64;
        return Ok(report);
    }

    for path in &cs.deleted {
        reconciler::apply_delete(&conn, &cfg.notes_dir, path)?;
    }
    for (old, new) in &cs.renamed {
        reconciler::apply_rename(&conn, &cfg.notes_dir, old, new)?;
    }

    let api_key = cfg.openai_api_key()?;
    let embedder = Embedder::new(
        &api_key,
        cfg.embedding_model.clone(),
        cfg.embedding_dim,
        cfg.embed_concurrency,
        cfg.embed_batch_size,
    );
    let summarizer = Summarizer::new(&api_key, cfg.summarizer_model.clone());
    let categorizer = Categorizer::new(&api_key, cfg.summarizer_model.clone());

    // Backfill any docs that still have doc_type IS NULL but are otherwise
    // up to date (v1→v2 migration). Treated as "process but expect no chunk
    // changes", letting pipeline's early-return path categorize them in
    // place instead of re-embedding everything.
    let mut backfill_paths = collect_doc_type_backfill_paths(&conn, &cfg.notes_dir)?;
    backfill_paths.retain(|p| {
        !cs.recovery.contains(p) && !cs.updated.contains(p) && !cs.created.contains(p)
    });
    if !backfill_paths.is_empty() && !quiet {
        tracing::info!("backfilling doc_type for {} existing docs", backfill_paths.len());
    }
    report.backfilled = backfill_paths.len();

    let mut errors = 0usize;
    for path in cs
        .recovery
        .iter()
        .chain(cs.updated.iter())
        .chain(cs.created.iter())
        .chain(backfill_paths.iter())
    {
        if let Err(e) =
            pipeline::process(cfg, &mut conn, &embedder, &summarizer, &categorizer, path, quiet)
                .await
        {
            tracing::error!("failed {}: {:#}", path.display(), e);
            record_failure(&conn, path, "process", &e)?;
            errors += 1;
        }
    }
    report.failed = errors;

    let next_gen = db::bump_generation(&conn)?;
    if !quiet {
        tracing::info!("bumped generation → {}", next_gen);
    }
    report.generation = next_gen;

    db::snapshot::export(&conn, &cfg.snapshot_path)?;
    if !quiet {
        tracing::info!("exported snapshot → {}", cfg.snapshot_path.display());
    }

    if errors > 0 {
        tracing::warn!("{} documents failed; see `failures` table", errors);
    }
    report.duration_ms = started.elapsed().as_millis() as u64;
    Ok(report)
}

/// Drop all indexed data from the live db (docs/chunks/vectors/failures)
/// and reset generation. The next `reindex` starts from scratch.
pub fn rebuild(cfg: &Config) -> Result<()> {
    let _lock = acquire_lock(&cfg.lock_path())?;
    let conn = db::open_live(
        &cfg.live_db,
        &cfg.embedding_model,
        cfg.embedding_dim,
        &cfg.summarizer_model,
    )?;
    db::truncate_all(&conn)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/// Semantic search over the snapshot (opened read-only): embed the query,
/// run two-pool KNN, fuse via RRF.
pub async fn search(cfg: &Config, opts: &SearchOptions) -> Result<SearchOutput> {
    let query = opts.query.trim();
    if query.is_empty() {
        bail!("empty query");
    }

    let conn = db::open_snapshot(&cfg.snapshot_path)?;
    let meta = db::read_snapshot_meta(&conn)?;
    tracing::debug!(
        "snapshot {} (gen={}, model={}, dim={})",
        cfg.snapshot_path.display(),
        meta.generation,
        meta.embedding_model,
        meta.embedding_dim,
    );

    // Strict validation: a type filter must be a known vocab entry.
    if let Some(t) = opts.doc_type.as_deref() {
        if !retrieval::doc_type_exists(&conn, t)? {
            let available: Vec<String> = retrieval::list_doc_types(&conn)?
                .into_iter()
                .map(|e| e.doc_type)
                .collect();
            bail!(
                "unknown doc_type '{}'. Available: {}",
                t,
                if available.is_empty() {
                    "(none — has reindex run with categorization?)".to_string()
                } else {
                    available.join(", ")
                }
            );
        }
    }

    let api_key = cfg.openai_api_key()?;
    let vec = embedder::embed_query(&api_key, &meta.embedding_model, query, meta.embedding_dim)
        .await?;

    // When `full` is on, we collapse to one entry per doc *after* search
    // but *before* the limit cap. Over-fetch a bit so the limit applies
    // sensibly to docs, not chunks.
    let effective_limit = if opts.full { opts.limit * 5 } else { opts.limit };
    let params = SearchParams::for_limit(effective_limit, opts.doc_type.as_deref());
    let mut raw = retrieval::search(&conn, &vec, params)?;
    if opts.max_distance > 0.0 {
        raw.retain(|h| h.raw_distance() <= opts.max_distance);
    }
    if opts.full {
        raw = retrieval::collapse_to_full_docs(raw, &cfg.notes_dir)?;
        raw.truncate(opts.limit);
    }

    Ok(SearchOutput {
        query: query.to_string(),
        results: raw.into_iter().map(to_public_hit).collect(),
    })
}

fn to_public_hit(h: RawHit) -> Hit {
    match h {
        RawHit::Doc { path, title, summary, doc_type, mtime, score, .. } => Hit {
            kind: "doc".into(),
            path,
            title,
            heading_path: None,
            content: summary.unwrap_or_default(),
            score: score.unwrap_or(0.0),
            mtime,
            doc_type,
        },
        RawHit::Chunk { path, title, heading_path, content, doc_type, mtime, score, .. } => Hit {
            kind: "chunk".into(),
            path,
            title,
            heading_path,
            content,
            score: score.unwrap_or(0.0),
            mtime,
            doc_type,
        },
        RawHit::DocFull { path, title, doc_type, mtime, content, score, .. } => Hit {
            kind: "doc_full".into(),
            path,
            title,
            heading_path: None,
            content,
            score: score.unwrap_or(0.0),
            mtime,
            doc_type,
        },
    }
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/// Read index status from the snapshot. A missing snapshot is not an
/// error: it yields `available = false` with empty counters.
pub fn status(cfg: &Config) -> Result<StatusReport> {
    if !cfg.snapshot_path.is_file() {
        return Ok(StatusReport::default());
    }
    let conn = db::open_snapshot(&cfg.snapshot_path)?;

    let count = |sql: &str| -> Result<i64> {
        Ok(conn.query_row(sql, [], |r| r.get(0))?)
    };

    Ok(StatusReport {
        available: true,
        generation: db::current_generation(&conn)?,
        docs: count("SELECT COUNT(*) FROM docs")?,
        chunks: count("SELECT COUNT(*) FROM chunks")?,
        chunks_with_vectors: count("SELECT COUNT(*) FROM vec_chunks")?,
        pending: count("SELECT COUNT(*) FROM docs WHERE index_state != 'ok'")?,
        failures: count("SELECT COUNT(*) FROM failures")?,
        last_compile_at: db::read_meta(&conn, "last_compile_at")?
            .and_then(|s| s.parse().ok())
            .unwrap_or(0),
        last_compile_host: db::read_meta(&conn, "last_compile_host")?.unwrap_or_default(),
        embedding_model: db::read_meta(&conn, "embedding_model")?.unwrap_or_default(),
    })
}

/// The doc_type vocabulary of the snapshot, ordered by descending count.
pub fn list_types(cfg: &Config) -> Result<Vec<TypeCount>> {
    let conn = db::open_snapshot(&cfg.snapshot_path)?;
    retrieval::list_doc_types(&conn)
}

// ---------------------------------------------------------------------------
// Directory layout
// ---------------------------------------------------------------------------

/// Create the user-side directory tree:
/// notes/, assets/images/, assets/attachments/, index/ (snapshot parent).
pub fn ensure_dirs(cfg: &Config) -> Result<()> {
    let mk = |p: &Path| -> Result<()> {
        std::fs::create_dir_all(p).with_context(|| format!("create {}", p.display()))
    };
    mk(&cfg.notes_dir)?;
    mk(&cfg.root.join("assets").join("images"))?;
    mk(&cfg.root.join("assets").join("attachments"))?;
    if let Some(parent) = cfg.snapshot_path.parent() {
        mk(parent)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn acquire_lock(path: &Path) -> Result<std::fs::File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let f = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(path)
        .with_context(|| format!("open lock {}", path.display()))?;
    if FileExt::try_lock_exclusive(&f).is_err() {
        bail!("another homekb compile is running ({})", path.display());
    }
    Ok(f)
}

fn record_failure(conn: &Connection, path: &Path, op: &str, e: &anyhow::Error) -> Result<()> {
    conn.execute(
        "INSERT INTO failures(path, op, error, attempted_at) VALUES (?, ?, ?, ?)",
        rusqlite::params![
            path.to_string_lossy(),
            op,
            format!("{e:#}"),
            now_secs(),
        ],
    )?;
    Ok(())
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn doc_type_backfill_count(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM docs WHERE doc_type IS NULL AND index_state = 'ok'",
        [],
        |r| r.get(0),
    )?)
}

fn collect_doc_type_backfill_paths(
    conn: &Connection,
    notes_root: &Path,
) -> Result<Vec<std::path::PathBuf>> {
    let mut stmt = conn.prepare(
        "SELECT path FROM docs WHERE doc_type IS NULL AND index_state = 'ok'",
    )?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(notes_root.join(r?));
    }
    Ok(out)
}
