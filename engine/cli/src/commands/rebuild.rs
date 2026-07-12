//! `homekb rebuild --force` — drop all indexed data.

use anyhow::{Result, bail};
use homekb_core::Config;

pub fn run(force: bool) -> Result<()> {
    if !force {
        bail!("rebuild requires --force; this deletes all indexed data");
    }
    let cfg = Config::load()?;
    homekb_core::rebuild(&cfg)?;
    println!("live db truncated; run `homekb reindex` to rebuild");
    Ok(())
}
