//! `homekb query` — semantic search from the command line.

use anyhow::{Result, bail};
use homekb_core::{Config, SearchOptions};
use std::io::Read;

pub fn run(
    query: Option<String>,
    json: bool,
    limit: usize,
    doc_type: Option<String>,
    full: bool,
    max_distance: f64,
) -> Result<()> {
    let query = match query {
        Some(s) => s,
        None => read_stdin()?,
    };
    let query = query.trim().to_string();
    if query.is_empty() {
        bail!("empty query (pass an argument or pipe text to stdin)");
    }

    let cfg = Config::load()?;
    let opts = SearchOptions {
        query,
        limit,
        doc_type,
        full,
        max_distance,
    };

    let rt = super::runtime()?;
    let out = rt.block_on(homekb_core::search(&cfg, &opts))?;

    let mut stdout = std::io::stdout().lock();
    if json {
        crate::output::write_json(&mut stdout, &out)?;
    } else {
        crate::output::write_human(&mut stdout, &out)?;
    }
    Ok(())
}

fn read_stdin() -> Result<String> {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s)?;
    Ok(s)
}
