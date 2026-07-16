//! `homekb init` — create the directory tree and write config.toml.

use anyhow::Result;
use homekb_core::{Config, ConfigOverrides};
use std::path::PathBuf;

pub fn run(root: Option<PathBuf>, notes: Option<PathBuf>, openai_key: Option<String>) -> Result<()> {
    let cfg = Config::load_with(ConfigOverrides {
        root,
        notes_dir: notes,
        openai_api_key: openai_key,
    })?;

    homekb_core::ensure_dirs(&cfg)?;
    let config_file = cfg.save()?;

    println!("homekb initialized");
    println!("  root      : {}", cfg.root.display());
    println!("  notes     : {}", cfg.notes_dir.display());
    println!("  snapshot  : {}", cfg.snapshot_path.display());
    println!("  live db   : {}", cfg.live_db.display());
    println!("  config    : {}", config_file.display());
    println!();
    println!("next steps:");
    println!("  1. drop .md notes into {}", cfg.notes_dir.display());
    if cfg.embedding.resolve_key().is_err() || cfg.summary.resolve_key().is_err() {
        println!("  2. configure AI providers in {}:", config_file.display());
        println!("     [embedding] + [summary] (both required; provider openai|gemini|voyage|cohere|custom)");
        println!("     [ask] is optional and falls back to [summary]");
        println!("  3. run `homekb reindex` to build the index");
        println!("  4. try `homekb query \"...\"`");
    } else {
        println!("  2. run `homekb reindex` to build the index");
        println!("  3. try `homekb query \"...\"`");
    }
    Ok(())
}
