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
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::api::{
    AppliedRoute, Hit, SearchOptions, SearchOutput, embed_search_query, list_types,
    search_with_vector,
};
use crate::config::Config;

const MAX_DISTANCE: f64 = 1.1;
const CHUNK_LIMIT: usize = 24;
const FULL_LIMIT: usize = 6;
/// Cap on the assembled context block sent to the synthesizer.
const CONTEXT_BUDGET_CHARS: usize = 60_000;
/// Answer returned when retrieval finds nothing relevant in the KB.
const EMPTY_KB_ANSWER: &str = "No relevant content found in the knowledge base for this question.";
/// Synthesizer system prompt — shared by the one-shot and streaming paths.
const SYNTH_SYSTEM: &str = "You answer questions about the user's personal knowledge base.\n\
    Rules:\n\
    - Use ONLY the provided sources; if they don't contain the answer, say so plainly.\n\
    - Cite sources inline like [1][2] matching the source numbers.\n\
    - Mind recency: snippets may describe things that changed over time.\n\
    - Answer in the same language as the question.\n\
    - Be direct and concise; no preamble.";

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

/// One frame on the streaming ask channel (docs/ARCHITECTURE.md "Streaming answer channel").
/// `Sources` is emitted right after retrieval — before the first token — so clients can
/// render the citation list immediately instead of waiting out the synthesize latency.
/// `Delta`s carry incremental answer text as the synthesizer produces tokens; exactly one
/// terminal `Done` follows, repeating the source metadata (kept identical to `Sources`
/// for backward compatibility with clients that only read the terminal frame).
#[derive(Debug, Clone)]
pub enum AskStreamEvent {
    Sources {
        citations: Vec<Citation>,
        hits: Vec<Hit>,
    },
    Delta(String),
    Done {
        citations: Vec<Citation>,
        hits: Vec<Hit>,
    },
}

#[derive(Debug, Default, Deserialize)]
struct Route {
    doc_type: Option<String>,
    #[serde(default)]
    needs_full: bool,
    /// Category-enumeration intent ("what recipes do I have"): retrieval
    /// switches from KNN to the whole-category summary sweep. Only honored
    /// when `doc_type` resolves to a known category.
    #[serde(default)]
    enumerate: bool,
}

type OpenAIClient = Client<async_openai::config::OpenAIConfig>;

/// Chat client for the ask pipeline (route + synthesize): the `[ask]`
/// endpoint when configured, else `[summary]` (docs/ARCHITECTURE.md
/// "config.toml" — [ask] is optional so retrieval-only integrations never
/// need it, yet `homekb ask` works out of the box).
fn client(config: &Config) -> Result<OpenAIClient> {
    let ep = config.ask_endpoint();
    let key = ep.resolve_key()?;
    Ok(crate::ai::embedder::shared_client(&ep.base_url, &key))
}

/// The retrieval half of ask, shared by the one-shot and streaming paths:
/// route ∥ embed → dual-pool KNN → per-source context block. `Ok(None)` means
/// nothing relevant was found (the caller answers with the empty-KB message).
struct Retrieval {
    /// Source documents in context order (first hit rank); consumed into `hits`.
    groups: Vec<SourceGroup>,
    /// Numbered `[n]` context block sent to the synthesizer.
    context_block: String,
    /// How many sources fit the budget — `citations` mirror exactly this many.
    cited: usize,
}

async fn retrieve(
    cli: &OpenAIClient,
    config: &Config,
    question: &str,
) -> Result<Option<Retrieval>> {
    // route ∥ embed — the query vector depends only on the question string,
    // so embedding runs concurrently with routing to hide the route latency.
    // A route failure is non-fatal (degrades to unfiltered chunk search);
    // an embed failure is fatal.
    let types = list_types(config).unwrap_or_default();
    let type_names: Vec<&str> = types.iter().map(|t| t.doc_type.as_str()).collect();
    let (route, vec) = tokio::join!(
        infer_route(cli, config, question, &type_names),
        embed_search_query(config, question),
    );
    let route = route.unwrap_or_default();
    let vec = vec.context("embed question")?;
    // The doc_type from the router must be in the known vocabulary; discard
    // unrecognized values — prefer no filter over an error.
    let doc_type = route
        .doc_type
        .filter(|t| types.iter().any(|k| &k.doc_type == t));

    // Enumeration intent + a resolved category → whole-category summary
    // sweep (coverage-first, no distance cutoff); the synthesizer judges
    // over every summary in the category. Otherwise: dual-pool KNN.
    let enumerate = route.enumerate && doc_type.is_some();
    let opts = if enumerate {
        SearchOptions {
            query: question.to_string(),
            doc_type,
            enumerate: true,
            max_distance: 0.0,
            ..Default::default()
        }
    } else {
        SearchOptions {
            query: question.to_string(),
            limit: if route.needs_full { FULL_LIMIT } else { CHUNK_LIMIT },
            doc_type,
            full: route.needs_full,
            group: false,
            max_distance: MAX_DISTANCE,
            enumerate: false,
        }
    };
    let out = search_with_vector(config, &opts, &vec)?;
    if out.results.is_empty() {
        return Ok(None);
    }

    // The context numbers *source documents*, not snippets, so the answer's
    // inline [n] markers point at sources.
    let groups = group_sources(out.results);
    let (context_block, cited) = build_context(&groups);
    Ok(Some(Retrieval {
        groups,
        context_block,
        cited,
    }))
}

/// Citations align 1:1 with the `[n]` numbering: only sources that actually made
/// it into the context block, in context order. Borrows `groups` so the caller
/// can still consume them into `hits` afterwards.
fn citations_of(r: &Retrieval) -> Vec<Citation> {
    r.groups
        .iter()
        .take(r.cited)
        .map(|g| Citation {
            path: g.path.clone(),
            title: g.title.clone(),
        })
        .collect()
}

/// One-shot ask: blocking synthesize, whole answer in one `AskOutput`.
/// Used by the local MCP, `homekb ask`, and any non-streaming caller.
pub async fn ask(config: &Config, question: &str) -> Result<AskOutput> {
    let question = question.trim();
    anyhow::ensure!(!question.is_empty(), "question is empty");
    let cli = client(config)?;

    let Some(r) = retrieve(&cli, config, question).await? else {
        return Ok(AskOutput {
            answer: EMPTY_KB_ANSWER.to_string(),
            citations: vec![],
            hits: vec![],
        });
    };

    let answer = synthesize(&cli, config, question, &r.context_block).await?;
    let citations = citations_of(&r);
    Ok(AskOutput {
        answer,
        citations,
        hits: r.groups.into_iter().map(SourceGroup::into_hit).collect(),
    })
}

/// Streaming ask (docs/ARCHITECTURE.md "Streaming answer channel"): identical
/// retrieval, but synthesize streams token chunks as `AskStreamEvent::Delta`,
/// followed by exactly one terminal `AskStreamEvent::Done` with the source
/// metadata. Sends on `tx`; a closed receiver (client gone) stops synthesis.
pub async fn ask_stream(
    config: &Config,
    question: &str,
    tx: &mpsc::UnboundedSender<AskStreamEvent>,
) -> Result<()> {
    let question = question.trim();
    anyhow::ensure!(!question.is_empty(), "question is empty");
    let cli = client(config)?;

    let Some(r) = retrieve(&cli, config, question).await? else {
        let _ = tx.send(AskStreamEvent::Sources {
            citations: vec![],
            hits: vec![],
        });
        let _ = tx.send(AskStreamEvent::Delta(EMPTY_KB_ANSWER.to_string()));
        let _ = tx.send(AskStreamEvent::Done {
            citations: vec![],
            hits: vec![],
        });
        return Ok(());
    };

    // Sources are fully known after retrieval — send them before synthesis so
    // the client renders the citation list while tokens are still cooking.
    let citations = citations_of(&r);
    let Retrieval {
        groups,
        context_block,
        ..
    } = r;
    let hits: Vec<Hit> = groups.into_iter().map(SourceGroup::into_hit).collect();
    let _ = tx.send(AskStreamEvent::Sources {
        citations: citations.clone(),
        hits: hits.clone(),
    });

    synthesize_stream(&cli, config, question, &context_block, tx).await?;

    let _ = tx.send(AskStreamEvent::Done { citations, hits });
    Ok(())
}

/// Routed search (docs/ARCHITECTURE.md `kb.query {route: true}`): run the
/// same router as ask, apply the inferred docType/enumeration to a plain
/// no-synthesis search, and echo the applied route in the output. Built for
/// UI list surfaces whose caller has no LLM of its own; agent callers route
/// themselves and pass explicit params instead.
///
/// Explicit `opts.doc_type` / `opts.enumerate` take precedence over the
/// inferred route. A router failure (or an unconfigured ask/summary
/// endpoint) degrades to a plain unrouted search — never an error.
pub async fn search_routed(config: &Config, opts: &SearchOptions) -> Result<SearchOutput> {
    let question = opts.query.trim();
    anyhow::ensure!(!question.is_empty(), "query is empty");

    let types = list_types(config).unwrap_or_default();
    let type_names: Vec<&str> = types.iter().map(|t| t.doc_type.as_str()).collect();

    // route ∥ embed, same trick as ask: the query vector depends only on
    // the query string, so embedding hides the route latency.
    let route_fut = async {
        match client(config) {
            Ok(cli) => infer_route(&cli, config, question, &type_names)
                .await
                .unwrap_or_default(),
            Err(_) => Route::default(),
        }
    };
    let (route, vec) = tokio::join!(route_fut, embed_search_query(config, question));
    let vec = vec.context("embed query")?;

    let inferred_type = route
        .doc_type
        .filter(|t| types.iter().any(|k| &k.doc_type == t));

    let mut applied = opts.clone();
    if applied.doc_type.is_none() {
        applied.doc_type = inferred_type;
    }
    if !applied.enumerate && route.enumerate && applied.doc_type.is_some() {
        applied.enumerate = true;
    }

    let mut out = search_with_vector(config, &applied, &vec)?;
    out.route = Some(AppliedRoute {
        doc_type: applied.doc_type.clone(),
        enumerate: applied.enumerate,
    });
    Ok(out)
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
         Output ONLY a JSON object: {{\"doc_type\": string|null, \"needs_full\": boolean, \
         \"enumerate\": boolean}}.\n\
         doc_type: pick one ONLY when the question clearly targets that category; \
         when in doubt output null (a false positive filter hides content; null never does).\n\
         enumerate: true when the question asks to list, browse, count, or pick across \
         EVERYTHING in a category — coverage intent (\"what recipes do I have\", \
         \"list my travel notes\", \"recommend two dishes\") — rather than to find \
         specific content. Requires doc_type to be set; conditions are fine \
         (\"recipes that use shrimp\" is still enumerate).\n\
         needs_full: true only when the user needs complete documents \
         (e.g. a full recipe procedure, a whole article, entire code); \
         false when snippets suffice (definitions, lookups, background). \
         Ignored when enumerate is true.",
        types.join(", ")
    );
    let req = CreateChatCompletionRequestArgs::default()
        .model(config.ask_endpoint().model)
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

/// Build the synthesize chat request (shared by the one-shot and streaming paths).
/// `stream` is left unset here and toggled by the caller: the streaming path
/// sets `stream = true` explicitly. NOTE: with the `byot` feature enabled
/// (which we need for lenient embedding responses), `create_stream` no longer
/// auto-sets `stream = true` — so the streaming path MUST set it itself, or the
/// request goes out non-streaming and the SSE reader yields zero tokens (empty
/// answer).
fn synthesize_request(
    config: &Config,
    question: &str,
    context_block: &str,
) -> Result<async_openai::types::chat::CreateChatCompletionRequest> {
    let user = format!("# Sources\n\n{context_block}\n# Question\n\n{question}");
    Ok(CreateChatCompletionRequestArgs::default()
        .model(config.ask_endpoint().model)
        .temperature(0.3)
        .max_tokens(1200u32)
        .messages([
            ChatCompletionRequestSystemMessageArgs::default()
                .content(SYNTH_SYSTEM)
                .build()?
                .into(),
            ChatCompletionRequestUserMessageArgs::default()
                .content(user)
                .build()?
                .into(),
        ])
        .build()?)
}

async fn synthesize(
    cli: &OpenAIClient,
    config: &Config,
    question: &str,
    context_block: &str,
) -> Result<String> {
    let req = synthesize_request(config, question, context_block)?;
    let resp = cli.chat().create(req).await?;
    let text = resp
        .choices
        .into_iter()
        .next()
        .and_then(|c| c.message.content)
        .context("no choices in chat completion")?;
    Ok(text.trim().to_string())
}

/// Streaming synthesize: forwards each OpenAI token chunk as an `AskStreamEvent::Delta`.
/// Stops early (Ok) if the receiver is dropped — that means the client disconnected.
async fn synthesize_stream(
    cli: &OpenAIClient,
    config: &Config,
    question: &str,
    context_block: &str,
    tx: &mpsc::UnboundedSender<AskStreamEvent>,
) -> Result<()> {
    let mut req = synthesize_request(config, question, context_block)?;
    req.stream = Some(true); // required under the `byot` feature (see synthesize_request)
    let mut stream = cli.chat().create_stream(req).await?;
    while let Some(item) = stream.next().await {
        let resp = item?;
        let Some(choice) = resp.choices.into_iter().next() else {
            continue;
        };
        if let Some(content) = choice.delta.content {
            if content.is_empty() {
                continue;
            }
            // Receiver gone (client disconnected) → stop synthesizing.
            if tx.send(AskStreamEvent::Delta(content)).is_err() {
                break;
            }
        }
    }
    Ok(())
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
