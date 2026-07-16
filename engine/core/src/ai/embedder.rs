//! OpenAI-protocol embeddings client with batching, concurrency limiting,
//! and retry, plus a lightweight single-query embedder used by search.
//!
//! Provider-agnostic: every built-in provider (openai / gemini / voyage /
//! cohere) and any `custom` endpoint speaks the OpenAI wire shape, so one
//! client type serves them all — only `base_url` + `api_key` differ
//! (docs/ARCHITECTURE.md "AI provider presets").

use anyhow::{Context, Result, bail};
use async_openai::{
    Client,
    types::embeddings::{CreateEmbeddingRequestArgs, EmbeddingInput},
};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::Semaphore;

type OpenAIClient = Client<async_openai::config::OpenAIConfig>;

/// Placeholder for empty/whitespace-only input. OpenAI silently accepts an
/// empty string (returns some vector), but Gemini's OpenAI-compat layer rejects
/// it with `400 content contains an empty Part` — and one empty item fails the
/// whole batch. An empty chunk or an empty LLM summary (Gemini sometimes
/// returns a blank digest) has no retrieval value anyway, so coerce it to a
/// single space to keep the request valid and provider-agnostic.
fn embeddable(text: &str) -> String {
    if text.trim().is_empty() {
        " ".to_string()
    } else {
        text.to_string()
    }
}

/// Lenient embeddings response for the BYOT path: some OpenAI-compatible
/// providers (e.g. Gemini's compat layer) omit per-datum fields like `index`
/// that the strict typed response requires. Data order is positional on
/// every known provider, which is all the callers rely on.
#[derive(Debug, serde::Deserialize)]
struct LenientEmbeddingResponse {
    data: Vec<LenientEmbedding>,
}

#[derive(Debug, serde::Deserialize)]
struct LenientEmbedding {
    embedding: Vec<f32>,
}

static SHARED_CLIENTS: OnceLock<Mutex<HashMap<(String, String), OpenAIClient>>> = OnceLock::new();

/// Process-wide client cache for one-off calls (query embedding, ask's
/// route/synthesize). Keyed by (base_url, api_key) since different config
/// sections may point at different providers. Sharing keeps the underlying
/// reqwest connection pool alive across requests in long-lived processes
/// (serve / tunnel), saving a DNS + TLS handshake per call.
pub fn shared_client(base_url: &str, api_key: &str) -> OpenAIClient {
    let map = SHARED_CLIENTS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut m = map.lock().expect("client cache poisoned");
    m.entry((base_url.to_string(), api_key.to_string()))
        .or_insert_with(|| build_client(base_url, api_key))
        .clone()
}

fn build_client(base_url: &str, api_key: &str) -> OpenAIClient {
    let cfg = async_openai::config::OpenAIConfig::default()
        .with_api_base(base_url)
        .with_api_key(api_key);
    Client::with_config(cfg)
}

pub struct Embedder {
    client: OpenAIClient,
    model: String,
    expected_dim: usize,
    batch_size: usize,
    semaphore: Arc<Semaphore>,
}

impl Embedder {
    pub fn new(
        api_key: &str,
        base_url: &str,
        model: impl Into<String>,
        expected_dim: usize,
        concurrency: usize,
        batch_size: usize,
    ) -> Self {
        Self {
            client: build_client(base_url, api_key),
            model: model.into(),
            expected_dim,
            batch_size,
            semaphore: Arc::new(Semaphore::new(concurrency.max(1))),
        }
    }

    /// Embed many texts. Internally chunks into `batch_size` requests and
    /// runs them concurrently up to the semaphore limit.
    pub async fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }

        // Split into batches preserving order.
        let batches: Vec<Vec<String>> = texts
            .chunks(self.batch_size)
            .map(|c| c.to_vec())
            .collect();

        // Run batches concurrently, but each batch acquires a permit.
        let mut handles = Vec::with_capacity(batches.len());
        for (idx, batch) in batches.into_iter().enumerate() {
            let sem = self.semaphore.clone();
            let client = self.client.clone();
            let model = self.model.clone();
            let expected_dim = self.expected_dim;
            handles.push(tokio::spawn(async move {
                let _permit = sem.acquire().await.expect("semaphore closed");
                let vecs = embed_one_batch(&client, &model, expected_dim, batch).await?;
                Ok::<(usize, Vec<Vec<f32>>), anyhow::Error>((idx, vecs))
            }));
        }

        let mut indexed: Vec<(usize, Vec<Vec<f32>>)> = Vec::with_capacity(handles.len());
        for h in handles {
            let (idx, vecs) = h.await.context("join embed task")??;
            indexed.push((idx, vecs));
        }
        indexed.sort_by_key(|(i, _)| *i);

        let mut out = Vec::with_capacity(texts.len());
        for (_, mut v) in indexed {
            out.append(&mut v);
        }
        Ok(out)
    }

    pub async fn embed_one(&self, text: &str) -> Result<Vec<f32>> {
        let mut v = self.embed_batch(&[text.to_string()]).await?;
        v.pop().context("empty embedding response")
    }
}

/// Embed a single query string. No batching, no semaphore — search embeds
/// exactly one string per invocation. `model` / `expected_dim` / `base_url`
/// come from the snapshot metadata so the query vector always matches the
/// index's vector space.
pub async fn embed_query(
    api_key: &str,
    base_url: &str,
    model: &str,
    query: &str,
    expected_dim: usize,
) -> Result<Vec<f32>> {
    let client = shared_client(base_url, api_key);

    let mut attempt = 0u32;
    loop {
        let req = CreateEmbeddingRequestArgs::default()
            .model(model)
            .input(EmbeddingInput::String(embeddable(query)))
            .build()?;
        let attempt_resp: Result<LenientEmbeddingResponse, _> =
            client.embeddings().create_byot(req).await;
        match attempt_resp {
            Ok(resp) => {
                let vec = resp
                    .data
                    .into_iter()
                    .next()
                    .context("empty embedding response")?
                    .embedding;
                if vec.len() != expected_dim {
                    bail!(
                        "embedding dim mismatch: model returned {}, index expects {}",
                        vec.len(),
                        expected_dim
                    );
                }
                return Ok(vec);
            }
            Err(err) => {
                attempt += 1;
                if attempt >= 3 {
                    return Err::<Vec<f32>, _>(anyhow::anyhow!(err))
                        .context("query embedding failed after retries");
                }
                let delay_ms = 300u64 * (1 << (attempt - 1));
                tracing::warn!("embed attempt {} failed: retrying in {}ms", attempt, delay_ms);
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            }
        }
    }
}

async fn embed_one_batch(
    client: &OpenAIClient,
    model: &str,
    expected_dim: usize,
    texts: Vec<String>,
) -> Result<Vec<Vec<f32>>> {
    let safe: Vec<String> = texts.iter().map(|t| embeddable(t)).collect();
    let mut attempt = 0u32;
    loop {
        let req = CreateEmbeddingRequestArgs::default()
            .model(model)
            .input(EmbeddingInput::StringArray(safe.clone()))
            .build()?;

        let attempt_resp: Result<LenientEmbeddingResponse, _> =
            client.embeddings().create_byot(req).await;
        match attempt_resp {
            Ok(resp) => {
                let mut out = Vec::with_capacity(resp.data.len());
                for d in resp.data {
                    if d.embedding.len() != expected_dim {
                        bail!(
                            "embedding dim mismatch: model returned {}, expected {}",
                            d.embedding.len(),
                            expected_dim
                        );
                    }
                    out.push(d.embedding);
                }
                return Ok(out);
            }
            Err(err) => {
                attempt += 1;
                if attempt >= 5 {
                    return Err::<Vec<Vec<f32>>, _>(anyhow::anyhow!(err))
                        .context("embeddings.create failed after retries");
                }
                let delay_ms = 500u64 * (1 << (attempt - 1));
                tracing::warn!("embedding attempt {} failed: {}; retrying in {}ms", attempt, err, delay_ms);
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            }
        }
    }
}
