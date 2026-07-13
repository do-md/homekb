//! kb.ask — recall + LLM answer synthesis.
//!
//! Pipeline (ported from claude-os kb.service `kbInferRoute`/`kbSynthesize`):
//! 1. route ∥ embed: the routing LLM call (optional doc_type filter +
//!                whether whole documents are needed) runs concurrently
//!                with embedding the question — the query vector depends
//!                only on the question string, not on the route;
//! 2. retrieve:   two-pool KNN + RRF search, locally, with the ready vector;
//! 3. synthesize: LLM answers strictly from the retrieved snippets, citing
//!                sources, following the language of the question.
//!
//! The user-facing output has no chunk granularity: the context block is
//! numbered per source document (one `[n]` per doc, its snippets listed
//! under it), `citations` aligns with that numbering, and `hits` collapses
//! to one entry per document (best snippet + match count).

use anyhow::{Context, Result};
use async_openai::{
    Client,
    types::chat::{
        ChatCompletionRequestSystemMessageArgs, ChatCompletionRequestUserMessageArgs,
        CreateChatCompletionRequestArgs,
    },
};
use serde::{Deserialize, Serialize};

use crate::api::{Hit, SearchOptions, embed_search_query, list_types, search_with_vector};
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
    Ok(crate::ai::embedder::shared_client(&key))
}

pub async fn ask(config: &Config, question: &str) -> Result<AskOutput> {
    let question = question.trim();
    anyhow::ensure!(!question.is_empty(), "question is empty");
    let cli = client(config)?;

    // 1. route ∥ embed — the query vector depends only on the question string,
    //    so embedding runs concurrently with routing to hide the route latency.
    //    A route failure is non-fatal (degrades to unfiltered chunk search);
    //    an embed failure is fatal.
    let types = list_types(config).unwrap_or_default();
    let type_names: Vec<&str> = types.iter().map(|t| t.doc_type.as_str()).collect();
    let (route, vec) = tokio::join!(
        infer_route(&cli, config, question, &type_names),
        embed_search_query(config, question),
    );
    let route = route.unwrap_or_default();
    let vec = vec.context("embed question")?;
    // The doc_type from the router must be in the known vocabulary; discard
    // unrecognized values — prefer no filter over an error.
    let doc_type = route
        .doc_type
        .filter(|t| types.iter().any(|k| &k.doc_type == t));

    // 2. retrieve (local KNN with the precomputed query vector)
    let opts = SearchOptions {
        query: question.to_string(),
        limit: if route.needs_full { FULL_LIMIT } else { CHUNK_LIMIT },
        doc_type,
        full: route.needs_full,
        group: false,
        max_distance: MAX_DISTANCE,
    };
    let out = search_with_vector(config, &opts, &vec)?;
    if out.results.is_empty() {
        return Ok(AskOutput {
            answer: "No relevant content found in the knowledge base for this question.".to_string(),
            citations: vec![],
            hits: vec![],
        });
    }

    // 3. synthesize. The context numbers *source documents*, not snippets,
    //    so the answer's inline [n] markers point at sources.
    let groups = group_sources(out.results);
    let (context_block, cited) = build_context(&groups);
    let answer = synthesize(&cli, config, question, &context_block).await?;

    // Citations align 1:1 with the [n] numbering: only sources that
    // actually made it into the context block, in context order.
    let citations: Vec<Citation> = groups
        .iter()
        .take(cited)
        .map(|g| Citation {
            path: g.path.clone(),
            title: g.title.clone(),
        })
        .collect();

    Ok(AskOutput {
        answer,
        citations,
        hits: groups.into_iter().map(SourceGroup::into_hit).collect(),
    })
}

/// All hits of one source document, in fused score order (best first).
struct SourceGroup {
    path: String,
    title: String,
    hits: Vec<Hit>,
}

impl SourceGroup {
    /// Collapse to one user-facing hit: the best hit's snippet and heading,
    /// `matches` = how many hits this document contributed.
    fn into_hit(self) -> Hit {
        let n = self.hits.len();
        let mut h = self.hits.into_iter().next().expect("group is non-empty");
        if h.kind == "chunk" {
            h.kind = "doc".into();
        }
        h.matches = Some(n);
        h
    }
}

/// Group fused results by source path, keeping first-occurrence order
/// (= the rank of each document's best hit).
fn group_sources(hits: Vec<Hit>) -> Vec<SourceGroup> {
    let mut groups: Vec<SourceGroup> = Vec::new();
    let mut index_by_path: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for h in hits {
        match index_by_path.get(&h.path) {
            Some(&i) => groups[i].hits.push(h),
            None => {
                index_by_path.insert(h.path.clone(), groups.len());
                groups.push(SourceGroup {
                    path: h.path.clone(),
                    title: h.title.clone().unwrap_or_else(|| h.path.clone()),
                    hits: vec![h],
                });
            }
        }
    }
    groups
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

/// One numbered entry per source document; the document's snippets are
/// listed under it with their heading paths. Returns the block plus how
/// many sources fit the budget, so citations can mirror the numbering.
fn build_context(groups: &[SourceGroup]) -> (String, usize) {
    let mut out = String::new();
    let mut cited = 0;
    for (i, g) in groups.iter().enumerate() {
        let mut entry = format!("[{n}] {title} ({path})\n", n = i + 1, title = g.title, path = g.path);
        for h in &g.hits {
            if let Some(hp) = h.heading_path.as_deref() {
                entry.push_str("› ");
                entry.push_str(hp);
                entry.push('\n');
            }
            entry.push_str(h.content.trim());
            entry.push('\n');
        }
        entry.push('\n');
        if out.len() + entry.len() > CONTEXT_BUDGET_CHARS {
            break;
        }
        out.push_str(&entry);
        cited = i + 1;
    }
    (out, cited)
}

async fn synthesize(
    cli: &OpenAIClient,
    config: &Config,
    question: &str,
    context_block: &str,
) -> Result<String> {
    let system = "You answer questions about the user's personal knowledge base.\n\
        Rules:\n\
        - Use ONLY the provided sources; if they don't contain the answer, say so plainly.\n\
        - Cite sources inline like [1][2] matching the source numbers.\n\
        - Mind recency: snippets may describe things that changed over time.\n\
        - Answer in the same language as the question.\n\
        - Be direct and concise; no preamble.";
    let user = format!("# Sources\n\n{context_block}\n# Question\n\n{question}");
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

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(path: &str, heading: Option<&str>, content: &str) -> Hit {
        Hit {
            kind: "chunk".into(),
            path: path.into(),
            title: Some(path.trim_end_matches(".md").to_uppercase()),
            heading_path: heading.map(str::to_string),
            content: content.into(),
            score: 0.0,
            mtime: 0,
            doc_type: None,
            matches: None,
        }
    }

    #[test]
    fn sources_are_grouped_numbered_and_collapsed() {
        let hits = vec![
            hit("a.md", Some("Setup"), "alpha"),
            hit("b.md", None, "bravo"),
            hit("a.md", Some("Usage"), "charlie"),
        ];
        let groups = group_sources(hits);
        let (ctx, cited) = build_context(&groups);

        // One [n] per document, snippets of the same doc under one entry.
        assert_eq!(cited, 2);
        assert!(ctx.contains("[1] A (a.md)\n› Setup\nalpha\n› Usage\ncharlie"));
        assert!(ctx.contains("[2] B (b.md)"));
        assert!(!ctx.contains("[3]"));

        let hits: Vec<Hit> = groups.into_iter().map(SourceGroup::into_hit).collect();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "a.md");
        assert_eq!(hits[0].kind, "doc");
        assert_eq!(hits[0].matches, Some(2));
        assert_eq!(hits[0].content, "alpha"); // best hit's snippet
        assert_eq!(hits[1].matches, Some(1));
    }

    #[test]
    fn context_budget_cut_keeps_citation_numbering_aligned() {
        // Second doc's snippet alone exceeds the budget once the first
        // entry is in, so only source [1] may be cited.
        let big = "x".repeat(CONTEXT_BUDGET_CHARS);
        let groups = group_sources(vec![hit("a.md", None, "alpha"), hit("b.md", None, &big)]);
        let (ctx, cited) = build_context(&groups);
        assert_eq!(cited, 1);
        assert!(ctx.contains("[1] A (a.md)"));
        assert!(!ctx.contains("[2]"));
    }
}
