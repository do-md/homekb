//! `homekb serve` — localhost HTTP RPC (the desktop client's data source).
//!
//! POST /rpc {method, params} → {ok, result} | {ok:false, error, message}
//! Binds 127.0.0.1 only; no auth in v1 (see docs/ARCHITECTURE.md).

use anyhow::Result;
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderValue, Method, header},
    routing::{get, post},
};
use homekb_core::Config;
use serde_json::{Value, json};
use std::sync::Arc;
use tower_http::cors::CorsLayer;

/// CORS 白名单（docs/ARCHITECTURE.md「本机 HTTP RPC」）：仅桌面 webview 与
/// next dev 调试来源。绝不放 `*`——否则任意浏览器网页都能驱动本机召回。
const ALLOWED_ORIGINS: [&str; 4] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "http://localhost:23333",
    "http://127.0.0.1:23333",
];

pub fn run(port: u16) -> Result<()> {
    let config = Arc::new(Config::load()?);
    let rt = super::runtime()?;
    rt.block_on(async move {
        let cors = CorsLayer::new()
            .allow_origin(
                ALLOWED_ORIGINS
                    .iter()
                    .map(|o| HeaderValue::from_static(o))
                    .collect::<Vec<_>>(),
            )
            .allow_methods([Method::GET, Method::POST])
            .allow_headers([header::CONTENT_TYPE]);
        let app = Router::new()
            .route("/rpc", post(rpc_handler))
            .route("/health", get(|| async { Json(json!({ "ok": true })) }))
            .layer(cors)
            .with_state(config);
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
        eprintln!("homekb serve: http://127.0.0.1:{port}  (POST /rpc)");
        axum::serve(listener, app).await?;
        Ok(())
    })
}

async fn rpc_handler(State(config): State<Arc<Config>>, Json(body): Json<Value>) -> Json<Value> {
    let method = body.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = body.get("params").cloned().unwrap_or_else(|| json!({}));
    match homekb_core::dispatch(&config, method, &params).await {
        Ok(result) => Json(json!({ "ok": true, "result": result })),
        Err(e) => Json(json!({ "ok": false, "error": e.code, "message": e.message })),
    }
}
