//! `homekb serve` — HTTP RPC + /assets (docs/ARCHITECTURE.md "HTTP RPC (homekb serve)").
//!
//! POST /rpc {method, params} → {ok, result} | {ok:false, error, message}
//! GET  /assets/<path>        → streams a file under <root>/assets/
//! GET  /health               → {ok:true} (always unauthenticated)
//!
//! Bind address decides the mode:
//! - loopback (default 127.0.0.1): no auth, fixed CORS allowlist — desktop data source.
//! - non-loopback ("direct mode"): Bearer serveToken (hkd_) required for non-loopback
//!   peers on /rpc and /assets (loopback peers stay exempt so the desktop keeps working);
//!   CORS is open (data is gated by the token, not by origin). The token is auto-generated
//!   and persisted to config.toml [serve] on the first public bind.

use anyhow::Result;
use axum::{
    Json, Router,
    body::Body,
    extract::{ConnectInfo, Path as AxPath, State},
    http::{HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use homekb_core::Config;
use serde_json::{Value, json};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

use super::assets::{guess_mime, resolve_asset_path};

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
    /// Some(token) = direct mode is enabled; non-loopback peers must present it.
    token: Option<String>,
}

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

    // Direct mode needs a credential: generate + persist once, print once.
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
                eprintln!("clients connect in direct mode with this token (Bearer).");
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
            .route("/assets/{*path}", get(asset_handler))
            .route("/health", get(|| async { Json(json!({ "ok": true })) }))
            .layer(cors)
            .with_state(state);
        let listener = tokio::net::TcpListener::bind((ip, port)).await?;
        let mode = if public {
            "direct mode (Bearer auth for remote peers)"
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

async fn asset_handler(
    State(state): State<Arc<ServeState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: axum::http::HeaderMap,
    AxPath(path): AxPath<String>,
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
    let Ok(file) = tokio::fs::File::open(&full).await else {
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
        .header(header::CONTENT_TYPE, guess_mime(&full))
        .header(header::CACHE_CONTROL, "private, max-age=3600");
    if let Some(len) = len {
        res = res.header(header::CONTENT_LENGTH, len);
    }
    res.body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}
