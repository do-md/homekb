//! OpenAI embeddings client with batching, concurrency limiting, and retry,
//! plus a lightweight single-query embedder used by search (from kb-query).

use anyhow::{Context, Result, bail};
use async_openai::{
    Client,
    types::embeddings::{CreateEmbeddingRequestArgs, EmbeddingInput},
};
use std::sync::Arc;
use tokio::sync::Semaphore;

type OpenAIClient = Client<async_openai::config::OpenAIConfig>;

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
        model: impl Into<String>,
        expected_dim: usize,
        concurrency: usize,
        batch_size: usize,
    ) -> Self {
        let cfg = async_openai::config::OpenAIConfig::default().with_api_key(api_key);
        Self {
            client: Client::with_config(cfg),
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
/// exactly one string per invocation. `model` / `expected_dim` come from the
/// snapshot metadata so the query vector always matches the index.
pub async fn embed_query(
    api_key: &str,
    model: &str,
    query: &str,
    expected_dim: usize,
) -> Result<Vec<f32>> {
    let cfg = async_openai::config::OpenAIConfig::default().with_api_key(api_key);
    let client: OpenAIClient = Client::with_config(cfg);

    let mut attempt = 0u32;
    loop {
        let req = CreateEmbeddingRequestArgs::default()
            .model(model)
            .input(EmbeddingInput::String(query.to_string()))
            .build()?;
        match client.embeddings().create(req).await {
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
    let mut attempt = 0u32;
    loop {
        let req = CreateEmbeddingRequestArgs::default()
            .model(model)
            .input(EmbeddingInput::StringArray(texts.clone()))
            .build()?;

        match client.embeddings().create(req).await {
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
