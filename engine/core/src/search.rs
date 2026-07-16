//! Two-pool retrieval + Reciprocal Rank Fusion (from kb-query).
//!
//! Pool A: top K against vec_docs (document summary embeddings).
//! Pool B: top K against vec_chunks (chunk embeddings).
//!
//! Each result item is ranked within its own pool, then assigned an
//! RRF score: `1 / (k + rank)`. For chunk items whose parent document
//! also appears in pool A, we add the document's RRF score as a bonus,
//! so chunks belonging to a topically-relevant document float upward.
//!
//! When `type_filter` is set, both pool queries are restricted to docs
//! with that `doc_type`. We also over-fetch (5x the requested k) since
//! sqlite-vec applies the JOIN-side WHERE only after the KNN — if you
//! ask for k=20 and only 3 of those happen to be the right type, you
//! get 3 results. The over-fetch buys headroom.

use anyhow::Result;
use rusqlite::{Connection, params};
use std::collections::HashMap;

use crate::api::TypeCount;
use crate::db::vec_ext::encode;

/// RRF dampening constant. 60 is the value from the original Cormack et al.
/// paper and is widely used as a default. Higher values flatten the curve.
const RRF_K: f64 = 60.0;

/// How much to over-fetch from each pool when a type filter is applied,
/// to compensate for post-KNN filtering trimming results.
const FILTERED_OVERFETCH: usize = 5;

/// Internal (pre-serialization) result item. The public API maps this to
/// `crate::api::Hit`.
#[derive(Debug, Clone)]
pub enum RawHit {
    Doc {
        path: String,
        title: Option<String>,
        summary: Option<String>,
        doc_type: Option<String>,
        mtime: i64,
        score: Option<f64>,
        raw_distance: f64,
        rank_in_pool: usize,
    },
    Chunk {
        path: String,
        title: Option<String>,
        heading_path: Option<String>,
        content: String,
        doc_type: Option<String>,
        mtime: i64,
        score: Option<f64>,
        raw_distance: f64,
        rank_in_pool: usize,
        /// If the parent document also appears in the summary pool,
        /// this is its rank there. Used by the RRF fusion to give a
        /// bonus to chunks whose document is independently relevant.
        parent_doc_rank: Option<usize>,
    },
    /// A whole-document result, emitted by `collapse_to_full_docs`.
    DocFull {
        path: String,
        title: Option<String>,
        doc_type: Option<String>,
        mtime: i64,
        /// Full file contents read from `<notes_dir>/<path>`.
        content: String,
        score: Option<f64>,
        raw_distance: f64,
    },
}

impl RawHit {
    pub fn path(&self) -> &str {
        match self {
            RawHit::Doc { path, .. }
            | RawHit::Chunk { path, .. }
            | RawHit::DocFull { path, .. } => path,
        }
    }
    fn set_score(&mut self, s: f64) {
        match self {
            RawHit::Doc { score, .. }
            | RawHit::Chunk { score, .. }
            | RawHit::DocFull { score, .. } => *score = Some(s),
        }
    }
    pub fn score(&self) -> f64 {
        match self {
            RawHit::Doc { score, .. }
            | RawHit::Chunk { score, .. }
            | RawHit::DocFull { score, .. } => score.unwrap_or(0.0),
        }
    }
    pub fn raw_distance(&self) -> f64 {
        match self {
            RawHit::Doc { raw_distance, .. }
            | RawHit::Chunk { raw_distance, .. }
            | RawHit::DocFull { raw_distance, .. } => *raw_distance,
        }
    }
}

pub struct SearchParams<'a> {
    /// How many candidates to pull from the chunk pool.
    pub chunk_k: usize,
    /// How many candidates to pull from the doc-summary pool.
    pub doc_k: usize,
    /// Final result size after fusion.
    pub limit: usize,
    /// Restrict to docs whose `doc_type` equals this value.
    pub type_filter: Option<&'a str>,
}

impl<'a> SearchParams<'a> {
    pub fn for_limit(limit: usize, type_filter: Option<&'a str>) -> Self {
        // Over-fetch each pool so fusion has material to work with.
        let mut chunk_k = (limit * 3).max(20);
        let mut doc_k = (limit * 2).max(10);
        if type_filter.is_some() {
            chunk_k *= FILTERED_OVERFETCH;
            doc_k *= FILTERED_OVERFETCH;
        }
        Self { chunk_k, doc_k, limit, type_filter }
    }
}

pub fn search(conn: &Connection, query_vec: &[f32], p: SearchParams) -> Result<Vec<RawHit>> {
    let qbytes = encode(query_vec);

    // Pool A: doc summaries.
    let doc_hits = query_docs(conn, &qbytes, p.doc_k, p.type_filter)?;
    // Pool B: chunks.
    let mut chunk_hits = query_chunks(conn, &qbytes, p.chunk_k, p.type_filter)?;

    // Build a map of doc path → rank in doc pool, so chunks can claim a bonus.
    let doc_rank_by_path: HashMap<String, usize> = doc_hits
        .iter()
        .filter_map(|h| match h {
            RawHit::Doc { path, rank_in_pool, .. } => Some((path.clone(), *rank_in_pool)),
            _ => None,
        })
        .collect();

    // Annotate chunks with their parent doc's rank (if any).
    for h in &mut chunk_hits {
        if let RawHit::Chunk { path, parent_doc_rank, .. } = h {
            *parent_doc_rank = doc_rank_by_path.get(path).copied();
        }
    }

    // Score everything via RRF.
    let mut all: Vec<RawHit> = Vec::with_capacity(doc_hits.len() + chunk_hits.len());
    for mut h in doc_hits {
        let rank = match &h {
            RawHit::Doc { rank_in_pool, .. } => *rank_in_pool,
            _ => 1,
        };
        h.set_score(1.0 / (RRF_K + rank as f64));
        all.push(h);
    }
    for mut h in chunk_hits {
        let (rank, parent_rank) = match &h {
            RawHit::Chunk { rank_in_pool, parent_doc_rank, .. } => (*rank_in_pool, *parent_doc_rank),
            _ => (1, None),
        };
        let mut score = 1.0 / (RRF_K + rank as f64);
        if let Some(pr) = parent_rank {
            score += 1.0 / (RRF_K + pr as f64);
        }
        h.set_score(score);
        all.push(h);
    }

    all.sort_by(|a, b| {
        b.score()
            .partial_cmp(&a.score())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    all.truncate(p.limit);
    Ok(all)
}

/// Category enumeration: **every** doc of `doc_type`, ranked by summary-vector
/// distance to the query (docs/ARCHITECTURE.md "Category enumeration").
///
/// Coverage-first — no `k` narrowing beyond the whole pool, no distance
/// cutoff: for "what do I have in X" intent the query vector is far from
/// every individual document, so KNN top-K + max-distance truncate the
/// category arbitrarily. Distance is kept purely as *ordering*, so a hybrid
/// question ("recipes that use shrimp") floats matches to the top while the
/// rest of the category stays present. Capped at `cap` (caller logs the
/// truncation — no silent caps). Docs whose summary vector is still pending
/// are absent from the pool and thus skipped.
pub fn enumerate_docs(
    conn: &Connection,
    query_vec: &[f32],
    doc_type: &str,
    cap: usize,
) -> Result<Vec<RawHit>> {
    let pool: i64 = conn.query_row("SELECT COUNT(*) FROM vec_docs", [], |r| r.get(0))?;
    if pool == 0 {
        return Ok(vec![]);
    }
    // KNN over the entire doc pool (k = pool size), filtered to the category:
    // guarantees full category coverage while sqlite-vec computes distances.
    let qbytes = encode(query_vec);
    let mut hits = query_docs(conn, &qbytes, pool as usize, Some(doc_type))?;
    for (i, h) in hits.iter_mut().enumerate() {
        // Rank-based score keeps Hit.score semantics consistent with fusion.
        h.set_score(1.0 / (RRF_K + (i + 1) as f64));
    }
    hits.truncate(cap);
    Ok(hits)
}

fn query_docs(
    conn: &Connection,
    qbytes: &[u8],
    k: usize,
    type_filter: Option<&str>,
) -> Result<Vec<RawHit>> {
    let sql = if type_filter.is_some() {
        r#"
        SELECT d.path, d.title, d.summary, d.doc_type, d.mtime, v.distance
        FROM vec_docs v
        JOIN docs d ON d.id = v.rowid
        WHERE v.embedding MATCH ? AND k = ? AND d.doc_type = ?
        ORDER BY v.distance
        "#
    } else {
        r#"
        SELECT d.path, d.title, d.summary, d.doc_type, d.mtime, v.distance
        FROM vec_docs v
        JOIN docs d ON d.id = v.rowid
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY v.distance
        "#
    };
    let mut stmt = conn.prepare(sql)?;
    let rows: Vec<rusqlite::Result<DocRowTuple>> = if let Some(t) = type_filter {
        stmt.query_map(params![qbytes, k as i64, t], read_doc_row)?.collect()
    } else {
        stmt.query_map(params![qbytes, k as i64], read_doc_row)?.collect()
    };

    let mut out = Vec::new();
    for (i, row) in rows.into_iter().enumerate() {
        let (path, title, summary, doc_type, mtime, distance) = row?;
        out.push(RawHit::Doc {
            path,
            title,
            summary,
            doc_type,
            mtime,
            score: None,
            raw_distance: distance,
            rank_in_pool: i + 1,
        });
    }
    Ok(out)
}

type DocRowTuple = (String, Option<String>, Option<String>, Option<String>, i64, f64);

fn read_doc_row(r: &rusqlite::Row) -> rusqlite::Result<DocRowTuple> {
    Ok((
        r.get::<_, String>(0)?,
        r.get::<_, Option<String>>(1)?,
        r.get::<_, Option<String>>(2)?,
        r.get::<_, Option<String>>(3)?,
        r.get::<_, i64>(4)?,
        r.get::<_, f64>(5)?,
    ))
}

fn query_chunks(
    conn: &Connection,
    qbytes: &[u8],
    k: usize,
    type_filter: Option<&str>,
) -> Result<Vec<RawHit>> {
    let sql = if type_filter.is_some() {
        r#"
        SELECT d.path, d.title, c.heading_path, c.content, d.doc_type, d.mtime, v.distance
        FROM vec_chunks v
        JOIN chunks c ON c.id = v.rowid
        JOIN docs   d ON d.id = c.doc_id
        WHERE v.embedding MATCH ? AND k = ? AND d.doc_type = ?
        ORDER BY v.distance
        "#
    } else {
        r#"
        SELECT d.path, d.title, c.heading_path, c.content, d.doc_type, d.mtime, v.distance
        FROM vec_chunks v
        JOIN chunks c ON c.id = v.rowid
        JOIN docs   d ON d.id = c.doc_id
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY v.distance
        "#
    };
    let mut stmt = conn.prepare(sql)?;
    let rows: Vec<rusqlite::Result<ChunkRowTuple>> = if let Some(t) = type_filter {
        stmt.query_map(params![qbytes, k as i64, t], read_chunk_row)?.collect()
    } else {
        stmt.query_map(params![qbytes, k as i64], read_chunk_row)?.collect()
    };

    let mut out = Vec::new();
    for (i, row) in rows.into_iter().enumerate() {
        let (path, title, heading_path, content, doc_type, mtime, distance) = row?;
        out.push(RawHit::Chunk {
            path,
            title,
            heading_path,
            content,
            doc_type,
            mtime,
            score: None,
            raw_distance: distance,
            rank_in_pool: i + 1,
            parent_doc_rank: None,
        });
    }
    Ok(out)
}

type ChunkRowTuple = (
    String,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
    i64,
    f64,
);

fn read_chunk_row(r: &rusqlite::Row) -> rusqlite::Result<ChunkRowTuple> {
    Ok((
        r.get::<_, String>(0)?,
        r.get::<_, Option<String>>(1)?,
        r.get::<_, Option<String>>(2)?,
        r.get::<_, String>(3)?,
        r.get::<_, Option<String>>(4)?,
        r.get::<_, i64>(5)?,
        r.get::<_, f64>(6)?,
    ))
}

/// Convert a chunk/doc-level result list into one entry per unique
/// document, with `content` loaded from disk. Preserves the original
/// score ordering: the rank of each output doc is the rank of its
/// highest-scored constituent hit.
pub fn collapse_to_full_docs(
    hits: Vec<RawHit>,
    notes_dir: &std::path::Path,
) -> Result<Vec<RawHit>> {
    // Walk hits in score order (input is already sorted). For each path,
    // remember the first occurrence — that's the highest-scored hit for
    // that doc.
    let mut order: Vec<String> = Vec::new();
    let mut first_per_path: HashMap<String, RawHit> = HashMap::new();
    for h in hits {
        let p = h.path().to_string();
        if !first_per_path.contains_key(&p) {
            order.push(p.clone());
            first_per_path.insert(p, h);
        }
    }

    let mut out = Vec::with_capacity(order.len());
    for p in order {
        let h = first_per_path.remove(&p).expect("present");
        let full_path = notes_dir.join(&p);
        let content = std::fs::read_to_string(&full_path).unwrap_or_else(|e| {
            tracing::warn!("failed to read {}: {}", full_path.display(), e);
            String::new()
        });
        let new_hit = match h {
            RawHit::Doc { path, title, doc_type, mtime, score, raw_distance, .. } => {
                RawHit::DocFull { path, title, doc_type, mtime, content, score, raw_distance }
            }
            RawHit::Chunk { path, title, doc_type, mtime, score, raw_distance, .. } => {
                RawHit::DocFull { path, title, doc_type, mtime, content, score, raw_distance }
            }
            RawHit::DocFull { .. } => h,
        };
        out.push(new_hit);
    }
    Ok(out)
}

pub fn list_doc_types(conn: &Connection) -> Result<Vec<TypeCount>> {
    let mut stmt = conn.prepare(
        "SELECT doc_type, COUNT(*) AS c FROM docs
         WHERE doc_type IS NOT NULL
         GROUP BY doc_type
         ORDER BY c DESC, doc_type ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(TypeCount {
            doc_type: r.get::<_, String>(0)?,
            count: r.get::<_, i64>(1)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Returns true if at least one doc with the given doc_type exists.
/// Used to validate a type filter strictly before querying.
pub fn doc_type_exists(conn: &Connection, t: &str) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM docs WHERE doc_type = ?",
        [t],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}
