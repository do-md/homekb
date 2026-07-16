//! `homekb reindex` — one incremental compile run.
//!
//! `--reclassify` additionally resets every doc_type first so the whole
//! category taxonomy re-emerges (repair for a collapsed vocabulary; does
//! not touch summaries or embeddings).

use anyhow::Result;
use homekb_core::Config;

pub fn run(quiet: bool, reclassify: bool) -> Result<()> {
    let cfg = Config::load()?;
    let rt = super::runtime()?;
    let report = rt.block_on(homekb_core::reindex_opts(&cfg, quiet, reclassify))?;
    if !quiet {
        println!(
            "reindex done: {} scanned, {} created, {} updated, {} deleted, {} renamed, \
             {} recovered, {} backfilled, {} failed (gen {}, {} ms)",
            report.scanned,
            report.created,
            report.updated,
            report.deleted,
            report.renamed,
            report.recovered,
            report.backfilled,
            report.failed,
            report.generation,
            report.duration_ms,
        );
    }
    Ok(())
}
