//! homekb — CLI front-end over homekb-core.
//!
//! Git-style subcommand CLI — the engine itself is the complete product
//! (docs/ARCHITECTURE.md「引擎优先」): compile, recall, Q&A, local MCP,
//! localhost HTTP RPC, relay pairing & tunnel.

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
    /// Ask a question: semantic recall + LLM-synthesized answer with citations.
    Ask {
        /// Question. If omitted, read from stdin.
        question: Option<String>,
        /// Emit machine-readable JSON instead of human-readable text.
        #[arg(long)]
        json: bool,
    },
    /// Create a note from FILE or stdin.
    New {
        /// Title (decides the filename); defaults to first heading / first line.
        #[arg(long)]
        title: Option<String>,
        /// Markdown file to import; omit to read stdin.
        file: Option<PathBuf>,
    },
    /// Local MCP server over stdio (for Claude Code / Codex: `claude mcp add homekb -- homekb mcp`).
    Mcp,
    /// Localhost HTTP RPC on 127.0.0.1 (desktop client data source).
    Serve {
        #[arg(long, default_value_t = 8765)]
        port: u16,
    },
    /// Register this machine with a relay server; writes [relay] to config.
    Register {
        /// Relay base URL, e.g. https://kb.example.com
        #[arg(long)]
        relay: Option<String>,
        /// Device name shown to paired clients (default: hostname).
        #[arg(long)]
        name: Option<String>,
    },
    /// Generate a pairing code via the relay (for phone web / Claude mobile).
    Pair,
    /// Resident tunnel to the relay + built-in periodic reindex.
    Tunnel {
        /// Seconds between built-in compile runs (0 = disable).
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
        Cmd::Ask { question, json } => {
            init_tracing(true);
            commands::ask::run(question, json)
        }
        Cmd::New { title, file } => {
            init_tracing(true);
            commands::new::run(title, file)
        }
        Cmd::Mcp => {
            // stdout 是 MCP 协议通道，日志只走 stderr 且保持安静
            init_tracing(true);
            commands::mcp::run()
        }
        Cmd::Serve { port } => {
            init_tracing(false);
            commands::serve::run(port)
        }
        Cmd::Register { relay, name } => {
            init_tracing(true);
            commands::relay::run_register(relay, name)
        }
        Cmd::Pair => {
            init_tracing(true);
            commands::relay::run_pair()
        }
        Cmd::Tunnel { interval } => {
            init_tracing(false);
            commands::tunnel::run(interval)
        }
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
