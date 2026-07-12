//! `homekb watch` — foreground compile loop (replaces the old launchd job).

use anyhow::Result;
use homekb_core::Config;
use std::time::Duration;

pub fn run(interval: u64) -> Result<()> {
    let interval = interval.max(1);
    let rt = super::runtime()?;
    tracing::info!("watching: reindex every {interval}s (ctrl-c to stop)");
    loop {
        // Reload config each round so edits take effect without a restart.
        match Config::load() {
            Ok(cfg) => match rt.block_on(homekb_core::reindex(&cfg, false)) {
                Ok(r) => {
                    if r.created + r.updated + r.deleted + r.renamed + r.recovered > 0 {
                        tracing::info!(
                            "reindexed: +{} ~{} -{} (gen {}, {} ms)",
                            r.created,
                            r.updated,
                            r.deleted,
                            r.generation,
                            r.duration_ms
                        );
                    }
                }
                Err(e) => tracing::error!("reindex failed: {e:#}"),
            },
            Err(e) => tracing::error!("config load failed: {e:#}"),
        }
        std::thread::sleep(Duration::from_secs(interval));
    }
}
