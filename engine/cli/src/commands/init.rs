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
    if cfg.openai_api_key.is_none() && std::env::var("OPENAI_API_KEY").is_err() {
        println!("  2. provide an OpenAI key: $OPENAI_API_KEY, `openai_api_key` in config.toml,");
        println!("     or ~/.config/openai/api_key");
        println!("  3. run `homekb reindex` to build the index");
        println!("  4. try `homekb query \"...\"`");
    } else {
        println!("  2. run `homekb reindex` to build the index");
        println!("  3. try `homekb query \"...\"`");
    }
    Ok(())
}
