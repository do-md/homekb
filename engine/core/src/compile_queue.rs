//! Event-driven compile coalescer.
//!
//! App-layer writes have exact trigger points, so they compile immediately
//! rather than waiting for the periodic fallback scan. `kb.create` / `kb.write`
//! call [`request_compile`] after a successful write (see docs/ARCHITECTURE.md
//! "Compile trigger model"). The periodic `com.homekb.compile` agent is demoted
//! to a folder-level robustness backstop for *out-of-band* changes (files
//! dragged straight into `~/.homekb/notes/`, external editors, cloud-drive
//! sync).
//!
//! Design:
//! - **Coalescing single-flight.** A burst of writes collapses into at most one
//!   in-flight reindex plus one queued follow-up (`dirty` flag + [`Notify`],
//!   one background worker per process). Reindex is already incremental at the
//!   embedding layer (stat-only scan; only changed files are re-embedded), so
//!   an immediate full reindex per write is cheap.
//! - **Cross-process lock — retry, never drop.** Reindex holds the
//!   cross-process `compile.lock`. A request that races the fallback agent's
//!   run gets [`CompileLockBusy`]; the worker keeps `dirty` set and retries
//!   after a short backoff, so the write lands right after the other run
//!   finishes instead of waiting for the next fallback tick. Any other error is
//!   dropped to the fallback (failing files are already recorded in the
//!   `failures` table by reindex).

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tokio::sync::Notify;

use crate::api::{CompileLockBusy, reindex};
use crate::config::Config;

/// Backoff before retrying when another process holds the compile lock. Each
/// retry is a cheap fail-fast `try_lock` (no scan), so this only needs to be
/// short enough to land promptly after the other run finishes.
const RETRY_BACKOFF: Duration = Duration::from_millis(1500);

struct Coordinator {
    /// A compile has been requested since the last run started.
    dirty: AtomicBool,
    /// Wakes the worker when a request arrives.
    notify: Notify,
    /// The background worker has been spawned (spawn exactly once).
    started: AtomicBool,
    /// Latest config to compile with (picks up hot-reloaded config). Held only
    /// for a cheap clone/replace — never across an `.await`.
    cfg: Mutex<Option<Config>>,
}

static COORD: OnceLock<Coordinator> = OnceLock::new();

fn coord() -> &'static Coordinator {
    COORD.get_or_init(|| Coordinator {
        dirty: AtomicBool::new(false),
        notify: Notify::new(),
        started: AtomicBool::new(false),
        cfg: Mutex::new(None),
    })
}

/// Request an incremental compile after an app-layer write. Non-blocking:
/// coalesces with any in-flight / queued run and returns immediately. Must be
/// called from within a tokio runtime context (all three transports —
/// serve/tunnel/MCP — dispatch within one), the same requirement as the
/// existing `kb.reindex` fire-and-forget spawn.
pub fn request_compile(config: &Config) {
    let c = coord();
    if let Ok(mut g) = c.cfg.lock() {
        *g = Some(config.clone());
    }
    c.dirty.store(true, Ordering::Release);
    // Spawn the single background worker on first request.
    if c
        .started
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
    {
        tokio::spawn(worker());
    }
    c.notify.notify_one();
}

async fn worker() {
    let c = coord();
    loop {
        // Drain all pending work before sleeping. `swap(false)` clears the flag
        // and reports whether a compile was pending; a request that arrives
        // mid-run re-sets it and we loop again (coalescing).
        while c.dirty.swap(false, Ordering::AcqRel) {
            let Some(cfg) = c.cfg.lock().ok().and_then(|g| g.clone()) else {
                break;
            };
            match reindex(&cfg, true).await {
                Ok(r) => {
                    tracing::info!(
                        "write-triggered compile done, generation={}",
                        r.generation
                    );
                }
                Err(e) if e.downcast_ref::<CompileLockBusy>().is_some() => {
                    // Another compiler holds the lock. Keep the request pending
                    // and retry shortly so the write still lands promptly.
                    c.dirty.store(true, Ordering::Release);
                    tokio::time::sleep(RETRY_BACKOFF).await;
                }
                Err(e) => {
                    // Genuine failure (config/db). Drop to the periodic
                    // fallback; failing files are recorded by reindex itself.
                    tracing::warn!("write-triggered compile failed: {e:#}");
                }
            }
        }
        // Nothing pending. A request that raced this point already stored a
        // Notify permit (set dirty, then notify_one), so `notified()` returns
        // immediately and we re-enter the drain loop — no missed wakeup.
        c.notify.notified().await;
    }
}
