//! homekb — CLI front-end over homekb-core.
//!
//! Git-style subcommand CLI — the engine itself is the complete product
//! (docs/ARCHITECTURE.md "engine-first"): compile, recall, Q&A, local MCP,
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
    ///
    /// No flag = run in the foreground (this is the launchd compile-service target).
    /// --install/--uninstall/--status manage the `com.homekb.compile` LaunchAgent (macOS).
    Watch {
        /// Seconds between compile runs.
        #[arg(long, default_value_t = 300)]
        interval: u64,
        /// Install as the launchd compile service (KeepAlive) and start it; then exit.
        #[arg(long, group = "watch_mode")]
        install: bool,
        /// Stop and remove the launchd compile service.
        #[arg(long, group = "watch_mode")]
        uninstall: bool,
        /// Report whether the launchd compile service is installed / running.
        #[arg(long, group = "watch_mode")]
        status: bool,
        /// With --status: emit machine-readable JSON.
        #[arg(long)]
        json: bool,
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
        /// Merge hits from the same source document into one entry
        /// (best snippet + match count); limit then counts documents.
        #[arg(long)]
        group: bool,
        /// Drop results whose embedding distance exceeds this (0 = no filter).
        #[arg(long, default_value_t = 0.0)]
        max_distance: f64,
        /// List the doc_type vocabulary (name + count) instead of searching.
        #[arg(long)]
        list_types: bool,
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
    /// HTTP RPC + /assets. Loopback bind (default) = desktop data source, no auth;
    /// a non-loopback --host enables the authenticated public bind (Bearer serveToken).
    Serve {
        /// Bind address (default 127.0.0.1; e.g. 0.0.0.0 for a public bind).
        #[arg(long)]
        host: Option<String>,
        /// Port (default 8765, or [serve] port in config.toml).
        #[arg(long)]
        port: Option<u16>,
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
    /// Leave the connection service: retire the registration, clear [relay], remove the tunnel.
    Unregister,
    /// Generate a pairing code via the connection service (for phone web / Claude mobile).
    Pair {
        /// Emit machine-readable JSON (desktop client parses this).
        #[arg(long)]
        json: bool,
    },
    /// Resident tunnel to the relay + built-in periodic reindex.
    ///
    /// No flag = run in the foreground (this is the launchd target).
    /// --install/--uninstall/--status manage a launchd LaunchAgent (macOS).
    Tunnel {
        /// Seconds between built-in compile runs (0 = disable).
        #[arg(long, default_value_t = 300)]
        interval: u64,
        /// Install as a launchd LaunchAgent (KeepAlive) and start it; then exit.
        #[arg(long, group = "tunnel_mode")]
        install: bool,
        /// Stop and remove the launchd LaunchAgent.
        #[arg(long, group = "tunnel_mode")]
        uninstall: bool,
        /// Report whether the launchd tunnel is installed / running.
        #[arg(long, group = "tunnel_mode")]
        status: bool,
        /// With --status: emit machine-readable JSON.
        #[arg(long)]
        json: bool,
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
        Cmd::Watch { interval, install, uninstall, status, json } => {
            let managing = install || uninstall || status;
            init_tracing(managing);
            match (install, uninstall, status) {
                (true, _, _) => commands::watch::run_install(interval),
                (_, true, _) => commands::watch::run_uninstall(),
                (_, _, true) => commands::watch::run_status(json),
                _ => commands::watch::run(interval),
            }
        }
        Cmd::Query { query, json, limit, doc_type, full, group, max_distance, list_types } => {
            // Keep stdout clean for results; only warnings/errors on stderr.
            init_tracing(true);
            commands::query::run(query, json, limit, doc_type, full, group, max_distance, list_types)
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
            // stdout is the MCP protocol channel; logging goes to stderr only (quiet)
            init_tracing(true);
            commands::mcp::run()
        }
        Cmd::Serve { host, port } => {
            init_tracing(false);
            commands::serve::run(host, port)
        }
        Cmd::Register { relay, name } => {
            init_tracing(true);
            commands::relay::run_register(relay, name)
        }
        Cmd::Unregister => {
            init_tracing(true);
            commands::relay::run_unregister()
        }
        Cmd::Pair { json } => {
            init_tracing(true);
            commands::relay::run_pair(json)
        }
        Cmd::Tunnel { interval, install, uninstall, status, json } => {
            let managing = install || uninstall || status;
            // Foreground: emit info logs; management ops: suppress to warn so results go to stdout.
            init_tracing(managing);
            match (install, uninstall, status) {
                (true, _, _) => commands::tunnel::run_install(interval),
                (_, true, _) => commands::tunnel::run_uninstall(),
                (_, _, true) => commands::tunnel::run_status(json),
                _ => commands::tunnel::run(interval),
            }
        }
    }
}

fn init_tracing(quiet: bool) {
    let level = if quiet { "warn" } else { "info" };
    // `homekb` = the binary crate (tunnel/serve emit under this target); prefix-matches
    // homekb_core / homekb_cli too. Without it the resident tunnel's launchd log is empty.
    let filter = std::env::var("RUST_LOG")
        .unwrap_or_else(|_| format!("homekb={level},homekb_core={level},homekb_cli={level}"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .with_writer(std::io::stderr)
        .init();
}
