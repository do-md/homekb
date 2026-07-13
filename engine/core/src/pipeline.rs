//! Per-document indexing pipeline.
//!
//! Three phases per document:
//!   1. (sync, short tx)  upsert docs row in `pending_embed`, diff chunks,
//!                        DELETE removed, INSERT new (without embeddings)
//!   2. (async)           call embedder + summarizer
//!   3. (sync, short tx)  write vec_chunks rows, optionally update summary
//!                        + vec_docs, set index_state=ok
//!
//! If the process crashes anywhere in phase 2, the row stays in
//! `pending_embed` and reconciler will pick it up on the next run.

use anyhow::{Context, Result};
use rusqlite::{Connection, params};
use std::collections::HashMap;
use std::path::Path;

use crate::ai::{Categorizer, Embedder, Summarizer};
use crate::chunker;
use crate::config::{Config, relative_path};
use crate::db::{self, vec_ext::encode};
use crate::hasher::sha256_hex;
use crate::types::{ChunkRow, DocId, NewChunk};

#[allow(clippy::too_many_arguments)]
pub async fn process(
    cfg: &Config,
    conn: &mut Connection,
    embedder: &Embedder,
    summarizer: &Summarizer,
    categorizer: &Categorizer,
    abs_path: &Path,
    quiet: bool,
) -> Result<()> {
    let rel = relative_path(&cfg.notes_dir, abs_path);
    if !quiet {
        tracing::info!("processing {}", rel);
    }

    let content = std::fs::read_to_string(abs_path)
        .with_context(|| format!("read {}", abs_path.display()))?;
    let new_hash = sha256_hex(content.as_bytes());

    let meta = std::fs::metadata(abs_path)?;
    let mtime = meta
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let size = meta.len() as i64;

    let title = extract_h1_title(&content);

    let plan = phase1_db(cfg, conn, &rel, &content, &new_hash, mtime, size, title.as_deref())?;

    if plan.inserted_ids.is_empty() && !plan.needs_summary && !plan.had_changes_in_phase1 {
        // Nothing to embed and no summary required.
        //
        // But: if doc_type is still NULL (post-migration backfill case),
        // categorize using the existing summary now without touching
        // chunks or embeddings.
        if plan.doc_type_is_null && plan.existing_summary.is_some() {
            let vocab = db::doc_type_vocab(conn)?;
            let summary_str = plan.existing_summary.as_deref().unwrap_or("");
            let preview = truncate_content_preview(&content, 2000);
            let title_str = title.as_deref().unwrap_or("");
            match categorizer
                .categorize(title_str, summary_str, &preview, &vocab)
                .await
            {
                Ok(dt) => {
                    conn.execute(
                        "UPDATE docs SET doc_type = ? WHERE id = ?",
                        params![dt, plan.doc_id],
                    )?;
                }
                Err(e) => tracing::warn!("backfill categorize failed for {}: {:#}", rel, e),
            }
        }
        // Same idea for the suggested question (v2→v3 backfill, or an
        // earlier digest whose JSON parse fell back to summary-only).
        if plan.question_is_null {
            match summarizer.question_only(&content).await {
                Ok(q) => {
                    conn.execute(
                        "UPDATE docs SET suggested_question = ? WHERE id = ?",
                        params![q, plan.doc_id],
                    )?;
                }
                Err(e) => tracing::warn!("backfill question failed for {}: {:#}", rel, e),
            }
        }
        finalize_state(conn, plan.doc_id, now_secs())?;
        return Ok(());
    }

    // Phase 2 — AI calls.
    let chunk_texts: Vec<String> = plan
        .inserted_chunks
        .iter()
        .map(|c| c.content.clone())
        .collect();
    let chunk_embeds = embedder.embed_batch(&chunk_texts).await?;

    let digest_data = if plan.needs_summary {
        let digest = summarizer.digest(&content).await?;
        let embed = embedder.embed_one(&digest.summary).await?;
        Some((digest, embed))
    } else {
        None
    };

    // The summary is current but the suggested question is missing
    // (v2→v3 backfill on a doc whose chunks changed, or an earlier
    // JSON-parse fallback). Best-effort: a failure just leaves it NULL
    // for the next run.
    let backfill_question = if !plan.needs_summary && plan.question_is_null {
        match summarizer.question_only(&content).await {
            Ok(q) => Some(q),
            Err(e) => {
                tracing::warn!("backfill question failed for {}: {:#}", rel, e);
                None
            }
        }
    } else {
        None
    };

    // Doc-type categorization. We classify whenever summary changes
    // (so it stays consistent with the doc), and also when doc_type is
    // currently NULL (handles the v1→v2 migration backfill case).
    let needs_doc_type = plan.needs_summary || plan.doc_type_is_null;
    let inferred_doc_type = if needs_doc_type {
        let vocab = db::doc_type_vocab(conn)?;
        let summary_for_categorizer = digest_data
            .as_ref()
            .map(|(d, _)| d.summary.as_str())
            .or(plan.existing_summary.as_deref())
            .unwrap_or("");
        let preview = truncate_content_preview(&content, 2000);
        let title_for_categorizer = title.as_deref().unwrap_or("");
        match categorizer
            .categorize(title_for_categorizer, summary_for_categorizer, &preview, &vocab)
            .await
        {
            Ok(t) => Some(t),
            Err(e) => {
                tracing::warn!("categorize failed for {}: {:#}", rel, e);
                None
            }
        }
    } else {
        None
    };

    // Phase 3 — write back.
    let tx = conn.transaction()?;
    for (id, vec) in plan.inserted_ids.iter().zip(chunk_embeds.iter()) {
        tx.execute(
            "INSERT INTO vec_chunks(rowid, embedding) VALUES (?, ?)",
            params![id, encode(vec)],
        )?;
        tx.execute(
            "UPDATE chunks SET embed_pending = 0 WHERE id = ?",
            params![id],
        )?;
    }
    if let Some((digest, embed)) = digest_data {
        tx.execute(
            "UPDATE docs SET summary = ?, summary_src_hash = ? WHERE id = ?",
            params![digest.summary, new_hash, plan.doc_id],
        )?;
        // Only overwrite the question when the digest actually produced
        // one; a JSON-parse fallback keeps the previous question (still
        // reasonable) instead of nulling it.
        if let Some(q) = &digest.question {
            tx.execute(
                "UPDATE docs SET suggested_question = ? WHERE id = ?",
                params![q, plan.doc_id],
            )?;
        }
        // INSERT OR REPLACE on a vec0 virtual table is not supported; emulate.
        tx.execute("DELETE FROM vec_docs WHERE rowid = ?", params![plan.doc_id])?;
        tx.execute(
            "INSERT INTO vec_docs(rowid, embedding) VALUES (?, ?)",
            params![plan.doc_id, encode(&embed)],
        )?;
    }
    if let Some(q) = backfill_question {
        tx.execute(
            "UPDATE docs SET suggested_question = ? WHERE id = ?",
            params![q, plan.doc_id],
        )?;
    }
    if let Some(dt) = inferred_doc_type {
        tx.execute(
            "UPDATE docs SET doc_type = ? WHERE id = ?",
            params![dt, plan.doc_id],
        )?;
    }
    tx.execute(
        "UPDATE docs SET index_state = 'ok', indexed_at = ? WHERE id = ?",
        params![now_secs(), plan.doc_id],
    )?;
    tx.commit()?;

    Ok(())
}

struct Phase1Plan {
    doc_id: DocId,
    /// Rowids of newly inserted chunks (same order as `inserted_chunks`).
    inserted_ids: Vec<i64>,
    /// The chunks themselves, used as embedding inputs.
    inserted_chunks: Vec<NewChunk>,
    needs_summary: bool,
    had_changes_in_phase1: bool,
    /// True when docs.doc_type was NULL prior to phase 1 (drives backfill
    /// of categorization even when no other content changed — used after
    /// the v1→v2 schema migration).
    doc_type_is_null: bool,
    /// True when docs.suggested_question was NULL prior to phase 1 (drives
    /// backfill of the suggested question — used after the v2→v3 schema
    /// migration, or when an earlier digest parse fell back to summary-only).
    question_is_null: bool,
    /// Pre-existing summary text, if any. Used as input to the categorizer
    /// when this run isn't regenerating the summary.
    existing_summary: Option<String>,
}

#[allow(clippy::too_many_arguments)]
fn phase1_db(
    cfg: &Config,
    conn: &mut Connection,
    rel: &str,
    content: &str,
    new_hash: &str,
    mtime: i64,
    size: i64,
    title: Option<&str>,
) -> Result<Phase1Plan> {
    let tx = conn.transaction()?;

    // Was a row already present?
    #[allow(clippy::type_complexity)]
    let existing: Option<(i64, Option<String>, Option<String>, Option<String>, Option<String>)> = tx
        .query_row(
            "SELECT id, summary, summary_src_hash, doc_type, suggested_question
             FROM docs WHERE path = ?",
            [rel],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .ok();

    let doc_id = match &existing {
        Some((id, _, _, _, _)) => {
            let id = *id;
            tx.execute(
                "UPDATE docs SET title = ?, content_hash = ?, mtime = ?, size_bytes = ?,
                                 index_state = 'pending_embed'
                 WHERE id = ?",
                params![title, new_hash, mtime, size, id],
            )?;
            id
        }
        None => {
            tx.execute(
                "INSERT INTO docs(path, title, content_hash, mtime, size_bytes,
                                  indexed_at, index_state)
                 VALUES (?, ?, ?, ?, ?, ?, 'pending_embed')",
                params![rel, title, new_hash, mtime, size, now_secs()],
            )?;
            tx.last_insert_rowid()
        }
    };

    let new_chunks = chunker::chunk(content, cfg.chunk_target_tokens, cfg.chunk_hard_max);

    // Load existing chunks.
    let mut stmt = tx.prepare(
        "SELECT id, content_hash FROM chunks WHERE doc_id = ?",
    )?;
    let old_rows: Vec<ChunkRow> = stmt
        .query_map(params![doc_id], |r| {
            Ok(ChunkRow {
                id: r.get(0)?,
                content_hash: r.get(1)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    // Diff by content_hash.
    let mut old_by_hash: HashMap<String, ChunkRow> =
        old_rows.iter().map(|r| (r.content_hash.clone(), r.clone())).collect();

    let mut reused: Vec<(i64, i64)> = Vec::new(); // (chunk_id, new_index)
    let mut inserted: Vec<(i64, NewChunk)> = Vec::new(); // (new_index, chunk)

    for (idx, nc) in new_chunks.iter().enumerate() {
        if let Some(old) = old_by_hash.remove(&nc.content_hash) {
            reused.push((old.id, idx as i64));
        } else {
            inserted.push((idx as i64, nc.clone()));
        }
    }
    // Anything left in old_by_hash is removed.
    let removed_ids: Vec<i64> = old_by_hash.values().map(|r| r.id).collect();

    // DELETE removed chunks (triggers cascade vec_chunks).
    for id in &removed_ids {
        tx.execute("DELETE FROM chunks WHERE id = ?", params![id])?;
    }

    // For reused chunks: move them to a temporary index space first to
    // avoid UNIQUE(doc_id, chunk_index) collisions during reordering.
    if !reused.is_empty() {
        tx.execute(
            "UPDATE chunks SET chunk_index = -chunk_index - 1 WHERE doc_id = ?",
            params![doc_id],
        )?;
        for (chunk_id, new_idx) in &reused {
            tx.execute(
                "UPDATE chunks SET chunk_index = ? WHERE id = ?",
                params![new_idx, chunk_id],
            )?;
        }
    }

    // INSERT new chunks.
    let mut inserted_ids = Vec::with_capacity(inserted.len());
    let inserted_chunks: Vec<NewChunk> = inserted.iter().map(|(_, c)| c.clone()).collect();
    for (idx, nc) in inserted {
        tx.execute(
            "INSERT INTO chunks(doc_id, chunk_index, heading_path, content, content_hash,
                                start_line, end_line, token_count, embed_pending)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
            params![
                doc_id,
                idx,
                nc.heading_path,
                nc.content,
                nc.content_hash,
                nc.start_line as i64,
                nc.end_line as i64,
                nc.token_count as i64,
            ],
        )?;
        inserted_ids.push(tx.last_insert_rowid());
    }

    let had_changes_in_phase1 = !removed_ids.is_empty() || !inserted_chunks.is_empty();

    let (needs_summary, doc_type_is_null, question_is_null, existing_summary) = match &existing {
        None => (true, true, true, None),
        Some((_, summary, src_hash, doc_type, question)) => {
            let needs = summary.is_none()
                || (src_hash.as_deref() != Some(new_hash) && had_changes_in_phase1);
            (needs, doc_type.is_none(), question.is_none(), summary.clone())
        }
    };

    tx.commit()?;

    Ok(Phase1Plan {
        doc_id,
        inserted_ids,
        inserted_chunks,
        needs_summary,
        had_changes_in_phase1,
        doc_type_is_null,
        question_is_null,
        existing_summary,
    })
}

fn finalize_state(conn: &Connection, doc_id: DocId, ts: i64) -> Result<()> {
    conn.execute(
        "UPDATE docs SET index_state = 'ok', indexed_at = ? WHERE id = ?",
        params![ts, doc_id],
    )?;
    Ok(())
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn extract_h1_title(content: &str) -> Option<String> {
    content
        .lines()
        .find_map(|l| l.strip_prefix("# ").map(|s| s.trim().to_string()))
}

/// Return the first `max_chars` UTF-8 code points of `content`.
/// Used to give the categorizer enough signal to judge the doc type
/// without paying for sending the whole document.
fn truncate_content_preview(content: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (i, ch) in content.chars().enumerate() {
        if i >= max_chars {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}
