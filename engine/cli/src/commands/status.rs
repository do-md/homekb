//! `homekb status` — index status from the snapshot.

use anyhow::Result;
use homekb_core::Config;

pub fn run(json: bool) -> Result<()> {
    let cfg = Config::load()?;
    let report = homekb_core::status(&cfg)?;

    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }

    if !report.available {
        println!(
            "no snapshot at {} — run `homekb reindex` first",
            cfg.snapshot_path.display()
        );
        return Ok(());
    }

    println!("snapshot         : {}", cfg.snapshot_path.display());
    println!("notes            : {}", cfg.notes_dir.display());
    println!("generation       : {}", report.generation);
    println!(
        "last compile     : {} (host: {})",
        crate::output::format_unix_date_time(report.last_compile_at),
        if report.last_compile_host.is_empty() { "—" } else { &report.last_compile_host },
    );
    println!("embedding model  : {}", report.embedding_model);
    println!("docs             : {}", report.docs);
    println!(
        "chunks           : {} ({} with vectors)",
        report.chunks, report.chunks_with_vectors
    );
    println!("pending          : {}", report.pending);
    println!("recorded failures: {}", report.failures);
    Ok(())
}
