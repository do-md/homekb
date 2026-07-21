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
        /// Reset ALL doc_type labels first so the category taxonomy
        /// re-emerges (repair for a collapsed vocabulary; summaries and
        /// embeddings are untouched).
        #[arg(long)]
        reclassify: bool,
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
        /// Category enumeration: return EVERY doc of --type (content =
        /// summary) ranked by relevance; limit/max-distance are ignored.
        #[arg(long)]
        enumerate: bool,
        /// Let the engine's LLM router infer --type / --enumerate from the
        /// query (needs the [ask] or [summary] endpoint configured).
        #[arg(long)]
        route: bool,
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
    /// Local MCP server over stdio (for Claude Code / Codex).
    ///
    /// No flag = run the server (this is what the agent launches).
    /// --install/--uninstall manage the registration in agent CLIs using this
    /// binary's ABSOLUTE path (agent MCP launchers don't necessarily share the
    /// shell's PATH; a bare `homekb` registration fails to connect). Omit the
    /// AGENT value to target every supported agent CLI found on PATH.
    Mcp {
        /// Register this engine as an MCP server in an agent CLI (claude, codex).
        #[arg(
            long,
            value_name = "AGENT",
            num_args = 0..=1,
            default_missing_value = "auto",
            group = "mcp_mode"
        )]
        install: Option<commands::mcp::McpAgent>,
        /// Remove the `homekb` MCP registration from an agent CLI (claude, codex).
        #[arg(
            long,
            value_name = "AGENT",
            num_args = 0..=1,
            default_missing_value = "auto",
            group = "mcp_mode"
        )]
        uninstall: Option<commands::mcp::McpAgent>,
    },
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
        /// Relay base URL (default: the official hosted relay).
        #[arg(long)]
        relay: Option<String>,
        /// Device name shown to paired clients (default: hostname).
        #[arg(long)]
        name: Option<String>,
    },
    /// Leave the connection service: retire the registration, clear [relay], remove the tunnel.
    Unregister,
    /// Start the engine on THIS machine: install + start the background compile
    /// (and, when registered, tunnel) launchd services. The reverse of `homekb stop`.
    Start {
        /// Seconds between scheduled compile runs.
        #[arg(long, default_value_t = 300)]
        interval: u64,
    },
    /// Pause the engine on THIS machine: stop the background tunnel + compile services.
    ///
    /// Reversible — keeps the binary, config, data, and the connection-service
    /// registration; remote devices just see the home go offline. Resume with
    /// `homekb start` (or `homekb pair` when not connected yet).
    Stop,
    /// Remove the engine from THIS machine — never touches your knowledge base (~/.homekb).
    ///
    /// Best-effort unregister (retire + clear [relay], AI keys kept) → stop+remove
    /// the launchd tunnel/compile services → delete the regenerable live.db working
    /// DB + logs → delete the binary (Homebrew/Scoop installs left for the package
    /// manager). Prints the plan and aborts without --yes (a built-in dry run).
    /// For a reversible pause that keeps everything installed, use `homekb stop`.
    Uninstall {
        /// Actually perform the removal (without this flag, only the plan is printed).
        #[arg(long)]
        yes: bool,
    },
    /// Generate a pairing code via the connection service (for phone web / Claude mobile).
    ///
    /// First run does the whole setup: not registered yet → registers with the
    /// official hosted service and installs the tunnel + compile background
    /// services (macOS), so `homekb pair` is the only command a fresh install
    /// needs before entering the code on the web.
    Pair {
        /// Emit machine-readable JSON (desktop client parses this).
        #[arg(long)]
        json: bool,
    },
    /// Create / list / revoke public share links for single notes.
    ///
    /// The note is served live from this machine through the connection
    /// service; password and expiry are enforced here, never on the relay.
    Share {
        /// Note path (relative to the notes dir) to share.
        path: Option<String>,
        /// Protect the link with a password (visible in shell history —
        /// prefer letting a paired client or MCP set it when that matters).
        #[arg(long)]
        password: Option<String>,
        /// Expire the link after N days (default: never).
        #[arg(long = "expires-days")]
        expires_days: Option<u32>,
        /// List active shares instead of creating one.
        #[arg(long, group = "share_mode")]
        list: bool,
        /// Revoke a share by its id (the link dies immediately).
        #[arg(long, group = "share_mode", value_name = "SHARE_ID")]
        revoke: Option<String>,
        /// Emit machine-readable JSON.
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
        Cmd::Reindex { quiet, reclassify } => {
            init_tracing(quiet);
            commands::reindex::run(quiet, reclassify)
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
        Cmd::Query {
            query, json, limit, doc_type, full, group, max_distance, list_types, enumerate, route,
        } => {
            // Keep stdout clean for results; only warnings/errors on stderr.
            init_tracing(true);
            commands::query::run(
                query, json, limit, doc_type, full, group, max_distance, list_types, enumerate,
                route,
            )
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
        Cmd::Mcp { install, uninstall } => {
            // stdout is the MCP protocol channel (server mode) / result lines
            // (management mode); logging goes to stderr only (quiet)
            init_tracing(true);
            match (install, uninstall) {
                (Some(agent), _) => commands::mcp::run_install(agent),
                (_, Some(agent)) => commands::mcp::run_uninstall(agent),
                _ => commands::mcp::run(),
            }
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
        Cmd::Start { interval } => {
            init_tracing(true);
            commands::start::run(interval)
        }
        Cmd::Stop => {
            init_tracing(true);
            commands::stop::run()
        }
        Cmd::Uninstall { yes } => {
            init_tracing(true);
            commands::uninstall::run(yes)
        }
        Cmd::Pair { json } => {
            init_tracing(true);
            commands::relay::run_pair(json)
        }
        Cmd::Share { path, password, expires_days, list, revoke, json } => {
            init_tracing(true);
            if list {
                commands::share::run_list(json)
            } else if let Some(id) = revoke {
                commands::share::run_revoke(id)
            } else if let Some(path) = path {
                commands::share::run_create(path, password, expires_days, json)
            } else {
                anyhow::bail!(
                    "usage: homekb share <PATH> [--password PW] [--expires-days N] | --list | --revoke <SHARE_ID>"
                )
            }
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
