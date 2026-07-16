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
    println!(
        "embedding        : {} ({})",
        report.embedding_model, report.embedding_provider
    );
    println!("docs             : {}", report.docs);
    println!(
        "chunks           : {} ({} with vectors)",
        report.chunks, report.chunks_with_vectors
    );
    println!("pending          : {}", report.pending);
    println!("recorded failures: {}", report.failures);

    // Category taxonomy overview + collapse warning. A vocabulary dominated
    // by `other` cannot drive category-filtered retrieval.
    let types = homekb_core::list_types(&cfg)?;
    if !types.is_empty() {
        let line = types
            .iter()
            .map(|t| format!("{} ({})", t.doc_type, t.count))
            .collect::<Vec<_>>()
            .join(", ");
        println!("doc types        : {}", line);
        let total: i64 = types.iter().map(|t| t.count).sum();
        let other: i64 = types
            .iter()
            .find(|t| t.doc_type == "other")
            .map(|t| t.count)
            .unwrap_or(0);
        if total >= 10 && other * 2 > total {
            println!(
                "⚠ taxonomy collapsed: {}/{} docs are 'other' — category \
                 filtering is ineffective. Run `homekb reindex --reclassify`.",
                other, total
            );
        }
    }
    Ok(())
}
