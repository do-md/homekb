//! `homekb new` — create a note from a file or stdin.

use anyhow::Result;
use homekb_core::{Config, create_note, ensure_dirs};
use std::io::Read;
use std::path::PathBuf;

pub fn run(title: Option<String>, file: Option<PathBuf>) -> Result<()> {
    let content = match file {
        Some(p) => std::fs::read_to_string(&p)?,
        None => {
            let mut buf = String::new();
            std::io::stdin().read_to_string(&mut buf)?;
            buf
        }
    };
    anyhow::ensure!(!content.trim().is_empty(), "note content is empty");
    let config = Config::load()?;
    ensure_dirs(&config)?;
    let created = create_note(&config, &content, title)?;
    println!("saved: {} ({})", created.path, created.title);
    println!("tip: the note will be searchable after the next compile run (reindex / watch / tunnel).");
    Ok(())
}
