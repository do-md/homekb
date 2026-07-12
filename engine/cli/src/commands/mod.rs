//! One module per subcommand. Future subcommands (mcp / register / pair /
//! tunnel) get their own module here and replace the [`not_implemented`]
//! stub in main.rs.

pub mod init;
pub mod query;
pub mod rebuild;
pub mod reindex;
pub mod status;
pub mod watch;

use anyhow::Result;

/// Stub for reserved subcommands: print a notice and exit with code 1.
pub fn not_implemented(name: &str) -> Result<()> {
    eprintln!("homekb {name}: not implemented yet");
    std::process::exit(1);
}

/// Single-threaded tokio runtime shared by the async commands.
pub fn runtime() -> Result<tokio::runtime::Runtime> {
    Ok(tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?)
}
