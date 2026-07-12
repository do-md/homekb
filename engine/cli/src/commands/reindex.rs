//! `homekb reindex` — one incremental compile run.

use anyhow::Result;
use homekb_core::Config;

pub fn run(quiet: bool) -> Result<()> {
    let cfg = Config::load()?;
    let rt = super::runtime()?;
    let report = rt.block_on(homekb_core::reindex(&cfg, quiet))?;
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
