//! kb.ask — recall + LLM answer synthesis.
//!
//! Pipeline (ported from claude-os kb.service `kbInferRoute`/`kbSynthesize`):
//! 1. route:      small LLM call infers an optional doc_type filter and
//!                whether whole documents are needed instead of chunks;
//! 2. retrieve:   two-pool KNN + RRF search;
//! 3. synthesize: LLM answers strictly from the retrieved snippets, citing
//!                sources, following the language of the question.

use anyhow::{Context, Result};
use async_openai::{
    Client,
    types::chat::{
        ChatCompletionRequestSystemMessageArgs, ChatCompletionRequestUserMessageArgs,
        CreateChatCompletionRequestArgs,
    },
};
use serde::{Deserialize, Serialize};

use crate::api::{Hit, SearchOptions, list_types, search};
use crate::config::Config;

const MAX_DISTANCE: f64 = 1.1;
const CHUNK_LIMIT: usize = 24;
const FULL_LIMIT: usize = 6;
/// Cap on the assembled context block sent to the synthesizer.
const CONTEXT_BUDGET_CHARS: usize = 60_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Citation {
    pub path: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskOutput {
    pub answer: String,
    pub citations: Vec<Citation>,
    pub hits: Vec<Hit>,
}

#[derive(Debug, Default, Deserialize)]
struct Route {
    doc_type: Option<String>,
    #[serde(default)]
    needs_full: bool,
}

type OpenAIClient = Client<async_openai::config::OpenAIConfig>;

fn client(config: &Config) -> Result<OpenAIClient> {
    let key = config.openai_api_key()?;
    let cfg = async_openai::config::OpenAIConfig::default().with_api_key(key);
    Ok(Client::with_config(cfg))
}

pub async fn ask(config: &Config, question: &str) -> Result<AskOutput> {
    let question = question.trim();
    anyhow::ensure!(!question.is_empty(), "question is empty");
    let cli = client(config)?;

    // 1. route（失败不致命，降级为无过滤 chunk 检索）
    let types = list_types(config).unwrap_or_default();
    let route = infer_route(&cli, config, question, &types.iter().map(|t| t.doc_type.as_str()).collect::<Vec<_>>())
        .await
        .unwrap_or_default();
    // 路由给出的 doc_type 必须在词表内，否则丢弃（宁可不过滤，不要报错）
    let doc_type = route
        .doc_type
        .filter(|t| types.iter().any(|k| &k.doc_type == t));

    // 2. retrieve
    let opts = SearchOptions {
        query: question.to_string(),
        limit: if route.needs_full { FULL_LIMIT } else { CHUNK_LIMIT },
        doc_type,
        full: route.needs_full,
        max_distance: MAX_DISTANCE,
    };
    let out = search(config, &opts).await?;
    if out.results.is_empty() {
        return Ok(AskOutput {
            answer: "知识库中没有找到与这个问题相关的内容。".to_string(),
            citations: vec![],
            hits: vec![],
        });
    }

    // 3. synthesize
    let context_block = build_context(&out.results);
    let answer = synthesize(&cli, config, question, &context_block).await?;

    let mut citations: Vec<Citation> = Vec::new();
    for h in &out.results {
        if !citations.iter().any(|c| c.path == h.path) {
            citations.push(Citation {
                path: h.path.clone(),
                title: h.title.clone().unwrap_or_else(|| h.path.clone()),
            });
        }
    }

    Ok(AskOutput {
        answer,
        citations,
        hits: out.results,
    })
}

async fn infer_route(
    cli: &OpenAIClient,
    config: &Config,
    question: &str,
    types: &[&str],
) -> Result<Route> {
    if types.is_empty() {
        return Ok(Route::default());
    }
    let system = format!(
        "You route knowledge-base queries. Known doc_type values: [{}].\n\
         Output ONLY a JSON object: {{\"doc_type\": string|null, \"needs_full\": boolean}}.\n\
         doc_type: pick one ONLY when the question clearly targets that category; \
         when in doubt output null (a false positive filter hides content; null never does).\n\
         needs_full: true only when the user needs complete documents \
         (e.g. a full recipe procedure, a whole article, entire code); \
         false when snippets suffice (definitions, lookups, background).",
        types.join(", ")
    );
    let req = CreateChatCompletionRequestArgs::default()
        .model(&config.summarizer_model)
        .temperature(0.0)
        .max_tokens(60u32)
        .messages([
            ChatCompletionRequestSystemMessageArgs::default()
                .content(system)
                .build()?
                .into(),
            ChatCompletionRequestUserMessageArgs::default()
                .content(question.to_string())
                .build()?
                .into(),
        ])
        .build()?;
    let resp = cli.chat().create(req).await?;
    let text = resp
        .choices
        .into_iter()
        .next()
        .and_then(|c| c.message.content)
        .unwrap_or_default();
    let json = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    Ok(serde_json::from_str::<Route>(json).unwrap_or_default())
}

fn build_context(hits: &[Hit]) -> String {
    let mut out = String::new();
    for (i, h) in hits.iter().enumerate() {
        let title = h.title.as_deref().unwrap_or(&h.path);
        let heading = h
            .heading_path
            .as_deref()
            .map(|hp| format!(" › {hp}"))
            .unwrap_or_default();
        let entry = format!(
            "[{n}] {title}{heading}（{path}）\n{content}\n\n",
            n = i + 1,
            path = h.path,
            content = h.content.trim()
        );
        if out.len() + entry.len() > CONTEXT_BUDGET_CHARS {
            break;
        }
        out.push_str(&entry);
    }
    out
}

async fn synthesize(
    cli: &OpenAIClient,
    config: &Config,
    question: &str,
    context_block: &str,
) -> Result<String> {
    let system = "You answer questions about the user's personal knowledge base.\n\
        Rules:\n\
        - Use ONLY the provided snippets; if they don't contain the answer, say so plainly.\n\
        - Cite sources inline like [1][2] matching the snippet numbers.\n\
        - Mind recency: snippets may describe things that changed over time.\n\
        - Answer in the same language as the question.\n\
        - Be direct and concise; no preamble.";
    let user = format!("# Snippets\n\n{context_block}\n# Question\n\n{question}");
    let req = CreateChatCompletionRequestArgs::default()
        .model(&config.summarizer_model)
        .temperature(0.3)
        .max_tokens(1200u32)
        .messages([
            ChatCompletionRequestSystemMessageArgs::default()
                .content(system)
                .build()?
                .into(),
            ChatCompletionRequestUserMessageArgs::default()
                .content(user)
                .build()?
                .into(),
        ])
        .build()?;
    let resp = cli.chat().create(req).await?;
    let text = resp
        .choices
        .into_iter()
        .next()
        .and_then(|c| c.message.content)
        .context("no choices in chat completion")?;
    Ok(text.trim().to_string())
}
