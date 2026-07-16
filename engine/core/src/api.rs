//! Public engine API.
//!
//! Result shapes serialize with camelCase field names and match the
//! "RPC methods" table in docs/ARCHITECTURE.md, so CLI `--json`, the local
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
    /// Docs whose LLM metadata (doc_type / suggested_question) was
    /// backfilled in place without re-embedding.
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
    /// Merge hits sharing a source document into one `doc` entry per path
    /// (list-mode UI). Ignored when `full` is set. `limit` then counts
    /// documents, and retrieval over-fetches to feed the grouping.
    pub group: bool,
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
            group: false,
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
    /// Grouped mode only: how many hits were merged into this entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matches: Option<usize>,
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
    pub embedding_provider: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeCount {
    pub doc_type: String,
    pub count: i64,
}

/// One home-screen "Try asking" entry: an auto-generated question a
/// recently updated document answers well.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub question: String,
    pub path: String,
    pub title: Option<String>,
    /// Unix seconds of the source document's mtime.
    pub mtime: i64,
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

    let mut conn = db::open_live(&cfg.live_db, &cfg.embedding, &cfg.summary.model)?;

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

    let backfill_needed = metadata_backfill_count(&conn)? > 0;
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

    let embed_key = cfg.embedding.resolve_key()?;
    let embedder = Embedder::new(
        &embed_key,
        &cfg.embedding.base_url,
        cfg.embedding.model.clone(),
        cfg.embedding.dim,
        cfg.embed_concurrency,
        cfg.embed_batch_size,
    );
    let summary_key = cfg.summary.resolve_key()?;
    let summarizer = Summarizer::new(&summary_key, &cfg.summary.base_url, cfg.summary.model.clone());
    let categorizer = Categorizer::new(&summary_key, &cfg.summary.base_url, cfg.summary.model.clone());

    // Backfill any docs that still miss doc_type (v1→v2 migration) or
    // suggested_question (v2→v3 migration) but are otherwise up to date.
    // Treated as "process but expect no chunk changes", letting pipeline's
    // early-return path fill them in place instead of re-embedding
    // everything.
    let mut backfill_paths = collect_metadata_backfill_paths(&conn, &cfg.notes_dir)?;
    backfill_paths.retain(|p| {
        !cs.recovery.contains(p) && !cs.updated.contains(p) && !cs.created.contains(p)
    });
    if !backfill_paths.is_empty() && !quiet {
        tracing::info!(
            "backfilling doc_type/suggested_question for {} existing docs",
            backfill_paths.len()
        );
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

    // Safety net: never overwrite a healthy snapshot with an empty one. If
    // every document failed to embed (a bad key / disabled billing / wrong
    // model name), the run produced zero vectors — exporting would replace the
    // last good snapshot with an unusable one ("empty knowledge base"). Keep
    // the previous snapshot so the user can still search while they fix it.
    // Genuinely-empty corpora (no errors, no vectors) still export normally.
    let vectors: i64 = conn.query_row("SELECT COUNT(*) FROM vec_chunks", [], |r| r.get(0))?;
    let would_regress = errors > 0 && vectors == 0 && cfg.snapshot_path.exists();
    if would_regress {
        tracing::warn!(
            "all {} documents failed to embed — keeping the previous snapshot \
             (check the [embedding] key / provider). Nothing was exported.",
            errors
        );
        report.generation = db::current_generation(&conn)?;
    } else {
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
    }
    report.duration_ms = started.elapsed().as_millis() as u64;
    Ok(report)
}

/// Drop all indexed data and reset the live db to the **current** embedding
/// config (docs/ARCHITECTURE.md — the one place allowed to cross vector
/// spaces). Used when the embedding model/provider/dim changes: it wipes rows,
/// rebuilds the vec0 tables at the new dimension, and re-seeds the meta, so the
/// coherence check in the next `open_live` passes.
///
/// It **deliberately leaves the exported snapshot in place**. The snapshot holds
/// old-model vectors; the safety comes from two sides instead of deleting it:
/// `import_if_newer` refuses to re-adopt a snapshot whose vector space differs
/// from the live db, and `reindex` skips the export when a run produced zero
/// vectors — so an embedding switch that fails (bad key, no billing) keeps the
/// last good snapshot queryable instead of leaving an empty knowledge base.
pub fn rebuild(cfg: &Config) -> Result<()> {
    let _lock = acquire_lock(&cfg.lock_path())?;
    db::rebuild_reset(&cfg.live_db, &cfg.embedding, &cfg.summary.model)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/// Semantic search over the snapshot (opened read-only): embed the query,
/// run two-pool KNN, fuse via RRF.
pub async fn search(cfg: &Config, opts: &SearchOptions) -> Result<SearchOutput> {
    let vec = embed_search_query(cfg, &opts.query).await?;
    search_with_vector(cfg, opts, &vec)
}

/// Embed a search query with the snapshot's embedding model/dim — the only
/// network step of a search. Split out from [`search`] so `ask` can run it
/// concurrently with its LLM routing call (the vector depends only on the
/// query string, not on the route).
pub async fn embed_search_query(cfg: &Config, query: &str) -> Result<Vec<f32>> {
    let query = query.trim();
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
    // The snapshot's vector space is authoritative: embed the query with the
    // provider/model recorded at compile time, not whatever the config says
    // now (a config switch without rebuild must not silently cross spaces).
    let (base_url, api_key) = query_embedding_endpoint(cfg, &meta)?;
    embedder::embed_query(&api_key, &base_url, &meta.embedding_model, query, meta.embedding_dim)
        .await
}

/// Resolve base URL + key for embedding a query against a snapshot compiled
/// by `meta.embedding_provider`. When the current `[embedding]` config still
/// points at the same provider, its key (and any base_url override) applies;
/// otherwise fall back to the snapshot's recorded base URL / provider preset
/// + env key, and warn about the mismatch.
fn query_embedding_endpoint(
    cfg: &Config,
    meta: &db::SnapshotMeta,
) -> Result<(String, String)> {
    if cfg.embedding.provider == meta.embedding_provider {
        return Ok((cfg.embedding.base_url.clone(), cfg.embedding.resolve_key()?));
    }
    tracing::warn!(
        "config [embedding] provider is \"{}\" but the snapshot was compiled with \"{}\"; \
         querying with the snapshot's provider (run `homekb rebuild --force` + `reindex` to switch)",
        cfg.embedding.provider,
        meta.embedding_provider
    );
    let base_url = meta
        .embedding_base_url
        .clone()
        .or_else(|| crate::config::preset_base_url(&meta.embedding_provider).map(String::from))
        .with_context(|| {
            format!(
                "snapshot provider \"{}\" has no recorded base URL",
                meta.embedding_provider
            )
        })?;
    let key = crate::config::resolve_provider_key(&meta.embedding_provider, None, "embedding")?;
    Ok((base_url, key))
}

/// Two-pool KNN + RRF with a precomputed query vector. Purely local.
pub fn search_with_vector(cfg: &Config, opts: &SearchOptions, vec: &[f32]) -> Result<SearchOutput> {
    let query = opts.query.trim();
    let conn = db::open_snapshot(&cfg.snapshot_path)?;

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

    // `full` and `group` both cap the limit on *documents*, so over-fetch
    // the fused list to give the collapse/grouping material to work with.
    let effective_limit = if opts.full || opts.group { opts.limit * 5 } else { opts.limit };
    let params = SearchParams::for_limit(effective_limit, opts.doc_type.as_deref());
    let mut raw = retrieval::search(&conn, vec, params)?;
    if opts.max_distance > 0.0 {
        raw.retain(|h| h.raw_distance() <= opts.max_distance);
    }

    let results = if opts.full {
        raw = retrieval::collapse_to_full_docs(raw, &cfg.notes_dir)?;
        raw.truncate(opts.limit);
        raw.into_iter().map(to_public_hit).collect()
    } else if opts.group {
        let mut grouped = group_by_source(raw.into_iter().map(to_public_hit).collect());
        grouped.truncate(opts.limit);
        grouped
    } else {
        raw.into_iter().map(to_public_hit).collect()
    };

    Ok(SearchOutput {
        query: query.to_string(),
        results,
    })
}

/// Merge hits sharing a source path into one `doc` entry per document.
/// Input is in fused score order; each document keeps the position, snippet
/// and headingPath of its first (best-ranked) hit, with `matches` counting
/// how many hits were merged.
fn group_by_source(hits: Vec<Hit>) -> Vec<Hit> {
    let mut order: Vec<String> = Vec::new();
    let mut merged: std::collections::HashMap<String, Hit> = std::collections::HashMap::new();
    for h in hits {
        match merged.get_mut(&h.path) {
            Some(g) => g.matches = Some(g.matches.unwrap_or(1) + 1),
            None => {
                order.push(h.path.clone());
                let mut g = h;
                g.kind = "doc".into();
                g.matches = Some(1);
                merged.insert(g.path.clone(), g);
            }
        }
    }
    order
        .into_iter()
        .filter_map(|p| merged.remove(&p))
        .collect()
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
            matches: None,
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
            matches: None,
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
            matches: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(kind: &str, path: &str, content: &str, score: f64) -> Hit {
        Hit {
            kind: kind.into(),
            path: path.into(),
            title: Some(path.trim_end_matches(".md").into()),
            heading_path: (kind == "chunk").then(|| format!("{content} heading")),
            content: content.into(),
            score,
            mtime: 0,
            doc_type: None,
            matches: None,
        }
    }

    #[test]
    fn group_by_source_merges_and_keeps_first_hit_order() {
        // Fused order: b's chunk ranks first, a appears three times after, c is last.
        let hits = vec![
            hit("chunk", "b.md", "b-best", 0.9),
            hit("chunk", "a.md", "a-best", 0.8),
            hit("doc", "a.md", "a-summary", 0.7),
            hit("chunk", "c.md", "c-only", 0.6),
            hit("chunk", "a.md", "a-tail", 0.5),
        ];
        let g = group_by_source(hits);
        assert_eq!(
            g.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(),
            ["b.md", "a.md", "c.md"],
        );
        // Every entry is collapsed to a doc, keeping the best-ranked snippet and count.
        assert!(g.iter().all(|h| h.kind == "doc"));
        assert_eq!(g[0].matches, Some(1));
        assert_eq!(g[1].matches, Some(3));
        assert_eq!(g[1].content, "a-best");
        assert_eq!(g[1].heading_path.as_deref(), Some("a-best heading"));
        assert_eq!(g[2].matches, Some(1));
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
        embedding_provider: db::read_meta(&conn, "embedding_provider")?
            .unwrap_or_else(|| "openai".into()),
    })
}

/// The doc_type vocabulary of the snapshot, ordered by descending count.
pub fn list_types(cfg: &Config) -> Result<Vec<TypeCount>> {
    let conn = db::open_snapshot(&cfg.snapshot_path)?;
    retrieval::list_doc_types(&conn)
}

/// Suggested questions for the most recently updated documents, newest
/// first. Graceful on a missing snapshot or a pre-v3 snapshot that has no
/// `suggested_question` column yet: both yield an empty list, never an
/// error (the home screen simply shows nothing).
pub fn suggestions(cfg: &Config, limit: usize) -> Result<Vec<Suggestion>> {
    if !cfg.snapshot_path.is_file() {
        return Ok(Vec::new());
    }
    let conn = db::open_snapshot(&cfg.snapshot_path)?;

    let has_column: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('docs') WHERE name = 'suggested_question'")?
        .exists([])?;
    if !has_column {
        return Ok(Vec::new());
    }

    let mut stmt = conn.prepare(
        "SELECT suggested_question, path, title, mtime FROM docs
         WHERE suggested_question IS NOT NULL AND suggested_question != ''
         ORDER BY mtime DESC LIMIT ?",
    )?;
    let rows = stmt.query_map([limit as i64], |r| {
        Ok(Suggestion {
            question: r.get(0)?,
            path: r.get(1)?,
            title: r.get(2)?,
            mtime: r.get(3)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Directory layout
// ---------------------------------------------------------------------------

/// Create the user-side directory tree:
/// notes/, drafts/, assets/images/, assets/attachments/, index/ (snapshot parent).
pub fn ensure_dirs(cfg: &Config) -> Result<()> {
    let mk = |p: &Path| -> Result<()> {
        std::fs::create_dir_all(p).with_context(|| format!("create {}", p.display()))
    };
    mk(&cfg.notes_dir)?;
    mk(&cfg.drafts_dir)?;
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

/// Docs that are indexed but still miss LLM-derived metadata: doc_type
/// (v1→v2 migration) or suggested_question (v2→v3 migration / an earlier
/// digest parse fallback). Both are backfilled by the pipeline's cheap
/// early-return path without re-embedding anything.
fn metadata_backfill_count(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM docs
         WHERE (doc_type IS NULL OR suggested_question IS NULL) AND index_state = 'ok'",
        [],
        |r| r.get(0),
    )?)
}

fn collect_metadata_backfill_paths(
    conn: &Connection,
    notes_root: &Path,
) -> Result<Vec<std::path::PathBuf>> {
    let mut stmt = conn.prepare(
        "SELECT path FROM docs
         WHERE (doc_type IS NULL OR suggested_question IS NULL) AND index_state = 'ok'",
    )?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(notes_root.join(r?));
    }
    Ok(out)
}
