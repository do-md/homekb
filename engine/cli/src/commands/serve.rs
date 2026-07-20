//! `homekb serve` — HTTP RPC + /assets (docs/ARCHITECTURE.md "HTTP RPC (homekb serve)").
//!
//! POST /rpc {method, params} → {ok, result} | {ok:false, error, message}
//! GET  /assets/<path>        → streams a file under <root>/assets/
//! POST /assets/<path>        → asset upload (raw bytes → final path)
//! GET  /health               → {ok:true} (always unauthenticated)
//!
//! Bind address decides the mode:
//! - loopback (default 127.0.0.1): no auth, fixed CORS allowlist — desktop data source.
//! - non-loopback (authenticated public bind): Bearer serveToken (hkd_) required for non-loopback
//!   peers on /rpc and /assets (loopback peers stay exempt so the desktop keeps working);
//!   CORS is open (data is gated by the token, not by origin). The token is auto-generated
//!   and persisted to config.toml [serve] on the first public bind.

use anyhow::Result;
use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{ConnectInfo, DefaultBodyLimit, Path as AxPath, RawQuery, State},
    http::{HeaderValue, Method, StatusCode, header},
    response::{
        IntoResponse, Response,
        sse::{Event, Sse},
    },
    routing::{get, post},
};
use futures::StreamExt;
use homekb_core::{AskStreamEvent, Config};
use serde_json::{Value, json};
use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;
use tower_http::cors::{Any, CorsLayer};

use super::assets::resolve_asset_path;
use super::image_variants::{
    image_cache_root, parse_image_query, resolve_variant, warm_default_variants,
};

/// CORS allowlist for loopback binds (docs/ARCHITECTURE.md): desktop webview and
/// Next.js dev origin only. Never `*` — that would let any browser page drive local retrieval.
const ALLOWED_ORIGINS: [&str; 4] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
];

struct ServeState {
    config: Config,
    /// Some(token) = public bind; non-loopback peers must present it.
    token: Option<String>,
}

/// Upload size cap (docs/ARCHITECTURE.md serve `POST /assets/<path>`).
const MAX_UPLOAD_BYTES: usize = 50 * 1024 * 1024;

pub fn run(host: Option<String>, port: Option<u16>) -> Result<()> {
    let mut config = Config::load()?;
    let serve_cfg = config.serve.clone().unwrap_or_default();
    let host = host
        .or(serve_cfg.host.clone())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let port = port.or(serve_cfg.port).unwrap_or(8765);

    let ip: IpAddr = host
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid --host {host} (must be an IP address)"))?;
    let public = !ip.is_loopback();

    // A public bind needs a credential: generate + persist once, print once.
    let token = if public {
        match serve_cfg.token.clone().filter(|t| !t.trim().is_empty()) {
            Some(t) => Some(t),
            None => {
                let t = generate_serve_token()?;
                let mut sc = config.serve.clone().unwrap_or_default();
                sc.token = Some(t.clone());
                config.serve = Some(sc);
                let path = config.save()?;
                eprintln!("generated serve token (saved to {}):", path.display());
                eprintln!("  {t}");
                eprintln!("remote API callers authenticate with this token (Bearer).");
                Some(t)
            }
        }
    } else {
        None
    };

    let rt = super::runtime()?;
    rt.block_on(async move {
        let cors = if public {
            // Data is gated by the Bearer token, not by origin (the Web UI may live anywhere).
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([Method::GET, Method::POST])
                .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
        } else {
            CorsLayer::new()
                .allow_origin(
                    ALLOWED_ORIGINS
                        .iter()
                        .map(|o| HeaderValue::from_static(o))
                        .collect::<Vec<_>>(),
                )
                .allow_methods([Method::GET, Method::POST])
                .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
        };
        let state = Arc::new(ServeState { config, token });
        let app = Router::new()
            .route("/rpc", post(rpc_handler))
            .route("/rpc/stream", post(rpc_stream_handler))
            .route(
                "/assets/{*path}",
                get(asset_handler)
                    .post(asset_upload_handler)
                    // Uploads are raw image/attachment bytes — axum's 2 MB default is far too small.
                    .layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES)),
            )
            .route("/health", get(|| async { Json(json!({ "ok": true })) }))
            .layer(cors)
            .with_state(state);
        let listener = tokio::net::TcpListener::bind((ip, port)).await?;
        let mode = if public {
            "public bind (Bearer auth for remote peers)"
        } else {
            "local (no auth)"
        };
        eprintln!("homekb serve: http://{host}:{port}  (POST /rpc, GET /assets/*) — {mode}");
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await?;
        Ok(())
    })
}

fn generate_serve_token() -> Result<String> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|e| anyhow::anyhow!("random source failed: {e}"))?;
    Ok(format!("hkd_{}", hex::encode(bytes)))
}

/// Loopback peers are exempt (the desktop webview keeps working when serve is publicly
/// bound); everyone else must present the serve token when one is configured.
fn authorized(state: &ServeState, peer: &SocketAddr, headers: &axum::http::HeaderMap) -> bool {
    let Some(expected) = &state.token else {
        return true; // loopback bind — no auth (v1 behavior)
    };
    if peer.ip().is_loopback() {
        return true;
    }
    let Some(auth) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    match auth
        .strip_prefix("Bearer ")
        .or_else(|| auth.strip_prefix("bearer "))
    {
        Some(token) => token.trim() == expected,
        None => false,
    }
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "ok": false, "error": "unauthorized", "message": "missing or invalid serve token" })),
    )
        .into_response()
}

async fn rpc_handler(
    State(state): State<Arc<ServeState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&state, &peer, &headers) {
        return unauthorized();
    }
    let method = body.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = body.get("params").cloned().unwrap_or_else(|| json!({}));
    match homekb_core::dispatch(&state.config, method, &params).await {
        Ok(result) => Json(json!({ "ok": true, "result": result })).into_response(),
        Err(e) => {
            Json(json!({ "ok": false, "error": e.code, "message": e.message })).into_response()
        }
    }
}

/// Encode a named SSE frame carrying a JSON payload on a single `data:` line
/// (compact JSON escapes newlines, so the client sees one frame per event).
fn sse_frame(name: &str, value: Value) -> Event {
    Event::default()
        .event(name)
        .data(serde_json::to_string(&value).unwrap_or_default())
}

fn sse_ask_event(ev: AskStreamEvent) -> Event {
    match ev {
        AskStreamEvent::Hits { hits } => sse_frame("hits", json!({ "hits": hits })),
        AskStreamEvent::Sources { citations, hits } => {
            sse_frame("sources", json!({ "citations": citations, "hits": hits }))
        }
        AskStreamEvent::Delta(text) => sse_frame("delta", json!({ "text": text })),
        AskStreamEvent::Done { citations, hits } => {
            sse_frame("done", json!({ "citations": citations, "hits": hits }))
        }
        AskStreamEvent::Results { hits, route } => {
            sse_frame("results", json!({ "hits": hits, "route": route }))
        }
    }
}

/// `POST /rpc/stream` — streaming variant, `kb.ask` only (docs/ARCHITECTURE.md
/// "HTTP RPC" + "Streaming answer channel"). Emits `delta`* → `done`, or a single
/// `error` frame. Auth + CORS identical to `/rpc`.
async fn rpc_stream_handler(
    State(state): State<Arc<ServeState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&state, &peer, &headers) {
        return unauthorized();
    }
    let method = body.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = body.get("params").cloned().unwrap_or_else(|| json!({}));
    if method != "kb.ask" {
        let frame = sse_frame("error", json!({ "code": "not_streamable", "message": "only kb.ask streams" }));
        let once = futures::stream::once(async move { Ok::<Event, Infallible>(frame) });
        return Sse::new(once).into_response();
    }
    let query = params
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // Auto mode (docs/ARCHITECTURE.md "Auto mode"): the router decides
    // answer-vs-list; a list decision short-circuits into one `results` frame.
    let auto = params.get("auto").and_then(|v| v.as_bool()).unwrap_or(false);

    // ask_stream sends Delta/Done on `tx`; its terminal Result becomes the trailing
    // `error` frame (if any) once the event channel drains.
    let (tx, rx) = mpsc::unbounded_channel::<AskStreamEvent>();
    let (err_tx, err_rx) = tokio::sync::oneshot::channel::<Option<(String, String)>>();
    let config = state.config.clone();
    tokio::spawn(async move {
        let result = homekb_core::ask_stream(&config, &query, auto, &tx).await;
        let _ = err_tx.send(result.err().map(|e| ("ask_failed".to_string(), format!("{e:#}"))));
    });

    let events = UnboundedReceiverStream::new(rx).map(|ev| Ok::<Event, Infallible>(sse_ask_event(ev)));
    let tail = futures::stream::once(async move {
        match err_rx.await {
            Ok(Some((code, message))) => {
                Some(Ok::<Event, Infallible>(sse_frame("error", json!({ "code": code, "message": message }))))
            }
            _ => None,
        }
    })
    .filter_map(|opt| async move { opt });

    Sse::new(events.chain(tail)).into_response()
}

/// `POST /assets/<path>` — asset upload (docs/ARCHITECTURE.md "HTTP RPC"):
/// raw bytes body; `<path>` is the suggested relative path (`images/<name>` /
/// `attachments/<name>`); the engine sanitizes + collision-avoids and returns
/// the final path. Auth identical to the GET.
async fn asset_upload_handler(
    State(state): State<Arc<ServeState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: axum::http::HeaderMap,
    AxPath(path): AxPath<String>,
    body: Bytes,
) -> Response {
    if !authorized(&state, &peer, &headers) {
        return unauthorized();
    }
    match homekb_core::save_asset(&state.config, &path, &body) {
        Ok(saved) => {
            // Warm the default web variants fire-and-forget so the first view
            // hits the cache (docs/ARCHITECTURE.md "Image variant service").
            if let Some(abs) = resolve_asset_path(&state.config, &saved.path) {
                tokio::spawn(warm_default_variants(
                    image_cache_root(&state.config),
                    abs,
                ));
            }
            Json(json!({ "ok": true, "path": saved.path })).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "bad_path", "message": format!("{e:#}") })),
        )
            .into_response(),
    }
}

async fn asset_handler(
    State(state): State<Arc<ServeState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: axum::http::HeaderMap,
    AxPath(path): AxPath<String>,
    RawQuery(query): RawQuery,
) -> Response {
    if !authorized(&state, &peer, &headers) {
        return unauthorized();
    }
    let Some(full) = resolve_asset_path(&state.config, &path) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "bad_path" })),
        )
            .into_response();
    };
    // Image variant service (docs/ARCHITECTURE.md): the representation to serve
    // is decided by query params + Accept — original file or cached variant.
    let params = parse_image_query(query.as_deref().unwrap_or(""));
    let accept = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok());
    let Some(resolved) =
        resolve_variant(&image_cache_root(&state.config), &full, &params, accept).await
    else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": "not_found" })),
        )
            .into_response();
    };
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|inm| inm == resolved.etag)
    {
        let mut res = Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, &resolved.etag);
        if resolved.varies {
            res = res.header(header::VARY, "Accept");
        }
        return res
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }
    let Ok(file) = tokio::fs::File::open(&resolved.path).await else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": "not_found" })),
        )
            .into_response();
    };
    let len = file.metadata().await.ok().map(|m| m.len());
    let stream = tokio_util::io::ReaderStream::new(file);
    let mut res = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, resolved.mime)
        .header(header::CACHE_CONTROL, "private, max-age=3600")
        .header(header::ETAG, &resolved.etag);
    if resolved.varies {
        res = res.header(header::VARY, "Accept");
    }
    if let Some(len) = len {
        res = res.header(header::CONTENT_LENGTH, len);
    }
    res.body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}
