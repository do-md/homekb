//! homekb — CLI front-end over homekb-core.
//!
//! Implemented: init / reindex / watch / query / status / rebuild.
//! Reserved (stubs, exit 1): mcp / register / pair / tunnel — each will get
//! its own module under `commands/` as it lands.

mod commands;
mod output;

use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(
    name = "homekb",
    version,
    about = "Personal markdown knowledge base: compile, semantic search, serve."
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Create the directory tree (~/.homekb) and write config.toml.
    Init {
        /// Data root (default ~/.homekb).
        #[arg(long)]
        root: Option<PathBuf>,
        /// Notes directory (default <root>/notes); may point at any existing md dir.
        #[arg(long)]
        notes: Option<PathBuf>,
        /// OpenAI API key to store in config.toml.
        #[arg(long = "openai-key")]
        openai_key: Option<String>,
    },
    /// Incrementally compile the notes into the index snapshot.
    Reindex {
        #[arg(long)]
        quiet: bool,
    },
    /// Foreground loop: reindex every N seconds. Errors are logged, not fatal.
    Watch {
        /// Seconds between compile runs.
        #[arg(long, default_value_t = 300)]
        interval: u64,
    },
    /// Semantic search against the snapshot.
    Query {
        /// Query string. If omitted, read from stdin.
        query: Option<String>,
        /// Emit machine-readable JSON instead of human-readable text.
        #[arg(long)]
        json: bool,
        /// Maximum results to return after fusion.
        #[arg(long, default_value_t = 10)]
        limit: usize,
        /// Restrict retrieval to docs with this doc_type.
        #[arg(long = "type", value_name = "DOC_TYPE")]
        doc_type: Option<String>,
        /// Return one entry per unique document with FULL file contents.
        #[arg(long)]
        full: bool,
        /// Drop results whose embedding distance exceeds this (0 = no filter).
        #[arg(long, default_value_t = 0.0)]
        max_distance: f64,
    },
    /// Print index status (counts, last compile, generation).
    Status {
        #[arg(long)]
        json: bool,
    },
    /// Drop all indexed data and start over from scratch.
    Rebuild {
        #[arg(long)]
        force: bool,
    },
    /// Local MCP server over stdio. (not implemented yet)
    Mcp,
    /// Register this machine with a relay server, writes [relay] to config. (not implemented yet)
    Register {
        #[arg(long)]
        relay: Option<String>,
        #[arg(long)]
        name: Option<String>,
    },
    /// Generate a pairing code via the relay. (not implemented yet)
    Pair,
    /// Persistent tunnel to the relay + built-in periodic reindex. (not implemented yet)
    Tunnel {
        #[arg(long, default_value_t = 300)]
        interval: u64,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Init { root, notes, openai_key } => {
            init_tracing(false);
            commands::init::run(root, notes, openai_key)
        }
        Cmd::Reindex { quiet } => {
            init_tracing(quiet);
            commands::reindex::run(quiet)
        }
        Cmd::Watch { interval } => {
            init_tracing(false);
            commands::watch::run(interval)
        }
        Cmd::Query { query, json, limit, doc_type, full, max_distance } => {
            // Keep stdout clean for results; only warnings/errors on stderr.
            init_tracing(true);
            commands::query::run(query, json, limit, doc_type, full, max_distance)
        }
        Cmd::Status { json } => {
            init_tracing(true);
            commands::status::run(json)
        }
        Cmd::Rebuild { force } => {
            init_tracing(false);
            commands::rebuild::run(force)
        }
        Cmd::Mcp => commands::not_implemented("mcp"),
        Cmd::Register { .. } => commands::not_implemented("register"),
        Cmd::Pair => commands::not_implemented("pair"),
        Cmd::Tunnel { .. } => commands::not_implemented("tunnel"),
    }
}

fn init_tracing(quiet: bool) {
    let level = if quiet { "warn" } else { "info" };
    let filter = std::env::var("RUST_LOG")
        .unwrap_or_else(|_| format!("homekb_core={level},homekb_cli={level}"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .with_writer(std::io::stderr)
        .init();
}
