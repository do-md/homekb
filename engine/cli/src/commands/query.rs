//! `homekb query` — semantic search from the command line.

use anyhow::{Result, bail};
use homekb_core::{Config, SearchOptions};
use std::io::Read;

#[allow(clippy::too_many_arguments)]
pub fn run(
    query: Option<String>,
    json: bool,
    limit: usize,
    doc_type: Option<String>,
    full: bool,
    group: bool,
    max_distance: f64,
    list_types: bool,
    enumerate: bool,
    route: bool,
) -> Result<()> {
    if list_types {
        return run_list_types(json);
    }
    if enumerate && doc_type.is_none() && !route {
        bail!("--enumerate requires --type (or --route to infer it)");
    }
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
        group,
        max_distance,
        enumerate,
    };

    let rt = super::runtime()?;
    let out = if route {
        rt.block_on(homekb_core::search_routed(&cfg, &opts))?
    } else {
        rt.block_on(homekb_core::search(&cfg, &opts))?
    };

    let mut stdout = std::io::stdout().lock();
    if json {
        crate::output::write_json(&mut stdout, &out)?;
    } else {
        crate::output::write_human(&mut stdout, &out)?;
    }
    Ok(())
}

/// `homekb query --list-types` — doc_type vocabulary of the snapshot,
/// same shape as the `kb.listTypes` RPC: `{"types":[{"docType":..,"count":..}]}`.
fn run_list_types(json: bool) -> Result<()> {
    let cfg = Config::load()?;
    let types = homekb_core::list_types(&cfg)?;

    let mut stdout = std::io::stdout().lock();
    if json {
        crate::output::write_json(&mut stdout, &serde_json::json!({ "types": types }))?;
    } else {
        use std::io::Write;
        for t in &types {
            writeln!(stdout, "{:<24} {}", t.doc_type, t.count)?;
        }
    }
    Ok(())
}

fn read_stdin() -> Result<String> {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s)?;
    Ok(s)
}
