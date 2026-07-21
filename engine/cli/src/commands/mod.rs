//! One module per subcommand. Future subcommands (mcp / register / pair /
//! tunnel) get their own module here and replace the [`not_implemented`]
//! stub in main.rs.

pub mod ask;
pub mod assets;
pub mod image_variants;
pub mod init;
#[cfg(target_os = "macos")]
pub use homekb_core::launchd;
pub mod mcp;
pub mod new;
pub mod query;
pub mod relay;
pub mod serve;
pub mod share;
pub mod tunnel;
pub mod rebuild;
pub mod reindex;
pub mod start;
pub mod status;
pub mod stop;
pub mod uninstall;
pub mod watch;

use anyhow::Result;

/// Single-threaded tokio runtime shared by the async commands.
pub fn runtime() -> Result<tokio::runtime::Runtime> {
    Ok(tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?)
}
