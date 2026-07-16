//! OpenAI chat-completion client for inferring a short category label
//! (`doc_type`) per document.
//!
//! The categorizer is shown the **current vocabulary** of doc_types
//! already present in the index, so it prefers reusing an existing
//! label when appropriate and only invents a new one when no existing
//! category fits. This produces an emergent but stable taxonomy.

use anyhow::{Context, Result};
use async_openai::{
    Client,
    types::chat::{
        ChatCompletionRequestSystemMessageArgs, ChatCompletionRequestUserMessageArgs,
        CreateChatCompletionRequestArgs,
    },
};

type OpenAIClient = Client<async_openai::config::OpenAIConfig>;

/// Built-in seed taxonomy. Always offered to the categorizer alongside the
/// categories that already exist in the index, so that:
/// - the very first documents of a fresh KB land on stable, well-known
///   labels instead of each inventing its own variant;
/// - the taxonomy is consistent across providers and corpus languages
///   (the labels themselves are part of the product contract — the ask
///   router and `query --type` filter on them).
/// Emergent growth on top is still allowed (a doc that fits none of these
/// gets a new snake_case label), per the "organization emerges at compile
/// time" principle.
pub const SEED_CATEGORIES: &[&str] = &[
    "recipe",
    "restaurant_log",
    "tech_note",
    "code_snippet",
    "how_to",
    "product_note",
    "reference",
    "book_note",
    "travel_log",
    "diary",
    "health",
    "finance",
];

const SYSTEM_PROMPT: &str = "You categorize markdown documents in a personal \
knowledge base.

You will be shown:
1. The categories available in this KB — those already in use (with doc \
counts) and the built-in ones.
2. The title, summary, and a content excerpt from a document.

Pick the BEST category for this document.

Rules:
- STRONGLY prefer an available category if it's a reasonable fit — even \
when its language differs from the document's (a Chinese cooking note \
still belongs in `recipe`). Reuse is the default; new categories should \
be rare. Never create a same-meaning duplicate of an available category \
in another language.
- Only invent a new category when no available one applies. Write a new \
category in the document's own primary language so its owner recognizes \
it: for Latin scripts use short lowercase snake_case (e.g. tech_note); \
for CJK use a compact plain form (e.g. 宠物饲养). Letters, digits, and \
underscores only — no punctuation, no emoji.
- `other` is a last-resort fallback, not a real category: use it only when \
nothing fits AND no sensible new category exists. Never pick it because it \
is frequent.
- Output ONLY the category name. No explanation, no quotes, no markdown, \
no trailing punctuation.";

/// Corrective follow-up when the model answered with a label that
/// sanitized to nothing (e.g. punctuation/emoji only).
const LABEL_RETRY_PROMPT: &str = "Your previous answer was not a valid \
category name. Answer again with ONLY a short category name made of \
letters, digits, or underscores (any language). Nothing else.";

pub struct Categorizer {
    client: OpenAIClient,
    model: String,
}

impl Categorizer {
    pub fn new(api_key: &str, base_url: &str, model: impl Into<String>) -> Self {
        let cfg = async_openai::config::OpenAIConfig::default()
            .with_api_base(base_url)
            .with_api_key(api_key);
        Self {
            client: Client::with_config(cfg),
            model: model.into(),
        }
    }

    /// Infer `doc_type` for a document.
    ///
    /// `title` may be empty; `summary` is the LLM-generated doc summary;
    /// `content_preview` is the first ~2 KB of raw content (truncated by
    /// the caller). `vocab` is `[(type_name, count), ...]` from
    /// `db::doc_type_vocab`, ordered by descending count.
    pub async fn categorize(
        &self,
        title: &str,
        summary: &str,
        content_preview: &str,
        vocab: &[(String, i64)],
    ) -> Result<String> {
        let vocab_block = vocab_block(vocab);

        let user_msg = format!(
            "Available categories:\n{vocab_block}\n\n\
             Document title: {title}\n\
             Summary: {summary}\n\n\
             Content excerpt:\n{content_preview}\n\n\
             Category:",
            title = if title.is_empty() { "(none)" } else { title },
        );

        let mut attempt = 0u32;
        let mut label_retry_done = false;
        loop {
            let mut messages = vec![
                ChatCompletionRequestSystemMessageArgs::default()
                    .content(SYSTEM_PROMPT)
                    .build()?
                    .into(),
                ChatCompletionRequestUserMessageArgs::default()
                    .content(user_msg.clone())
                    .build()?
                    .into(),
            ];
            if label_retry_done {
                messages.push(
                    ChatCompletionRequestUserMessageArgs::default()
                        .content(LABEL_RETRY_PROMPT)
                        .build()?
                        .into(),
                );
            }
            let req = CreateChatCompletionRequestArgs::default()
                .model(&self.model)
                .temperature(0.1)
                .max_tokens(16u32)
                .messages(messages)
                .build()?;

            match self.client.chat().create(req).await {
                Ok(resp) => {
                    let raw = resp
                        .choices
                        .into_iter()
                        .next()
                        .context("no choices in categorize response")?
                        .message
                        .content
                        .unwrap_or_default();
                    match sanitize(&raw) {
                        Some(label) => return Ok(label),
                        // Degenerate label (nothing valid survives — e.g.
                        // punctuation/emoji only). One corrective retry;
                        // then fall back to `other` loudly instead of
                        // silently poisoning the taxonomy.
                        None if !label_retry_done => {
                            label_retry_done = true;
                            tracing::warn!(
                                "categorize returned a degenerate label {:?}; \
                                 retrying with an explicit format instruction",
                                raw.trim()
                            );
                        }
                        None => {
                            tracing::warn!(
                                "categorize still degenerate after retry ({:?}); \
                                 falling back to 'other'",
                                raw.trim()
                            );
                            return Ok("other".to_string());
                        }
                    }
                }
                Err(err) => {
                    attempt += 1;
                    if attempt >= 4 {
                        return Err::<String, _>(anyhow::anyhow!(err))
                            .context("categorize chat.create failed after retries");
                    }
                    let delay_ms = 400u64 * (1 << (attempt - 1));
                    tracing::warn!(
                        "categorize attempt {} failed: retrying in {}ms",
                        attempt,
                        delay_ms
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                }
            }
        }
    }
}

/// Render the available-category list for the prompt: the categories already
/// in use (with counts, most frequent first) followed by the built-in seeds
/// not yet in use. The `other` bucket is deliberately excluded: it is a
/// fallback, and showing it with a high count turns the "prefer available
/// categories" rule into a black hole that sucks every document into `other`.
fn vocab_block(vocab: &[(String, i64)]) -> String {
    let mut lines: Vec<String> = vocab
        .iter()
        .filter(|(name, _)| name != "other")
        .map(|(name, c)| format!("- {name} ({c} docs)"))
        .collect();
    for seed in SEED_CATEGORIES {
        if !vocab.iter().any(|(name, _)| name == seed) {
            lines.push(format!("- {seed} (built-in)"));
        }
    }
    lines.join("\n")
}

/// Normalize raw LLM output into the doc_type key space: **Unicode letters,
/// digits, and underscores, in any script** — NFC-normalized, lowercase-folded
/// (a no-op for caseless scripts like CJK), interior whitespace/dashes turned
/// into underscores, quotes/punctuation/emoji stripped, capped at 32 chars.
///
/// This is a *normalization + validation* layer, not a language gate: a
/// Chinese label like `菜谱` is a first-class key. The key space must stay
/// language-open because labels can also emerge from the corpus language and,
/// later, from user-defined categories. (The previous ASCII-only version
/// silently dropped every CJK label — which is how a Chinese-answering model
/// funneled a whole corpus into `other`.)
///
/// Returns `None` when nothing survives (empty response, or a label made
/// entirely of dropped characters — emoji/punctuation only). The caller
/// treats that as a retryable failure instead of silently coercing a label.
fn sanitize(raw: &str) -> Option<String> {
    use unicode_normalization::UnicodeNormalization;
    let trimmed = raw
        .trim()
        .trim_matches(|c: char| c == '"' || c == '\'' || c == '`' || c == '.');
    let nfc: String = trimmed.nfc().collect();
    let mut out = String::with_capacity(nfc.len());
    for ch in nfc.chars() {
        match ch {
            ' ' | '-' | '\t' => out.push('_'),
            '_' => out.push('_'),
            c if c.is_alphanumeric() => out.extend(c.to_lowercase()),
            _ => {} // drop punctuation, emoji, symbols
        }
    }
    // Collapse repeated underscores.
    let mut collapsed = String::with_capacity(out.len());
    let mut last_underscore = false;
    for ch in out.chars() {
        if ch == '_' {
            if !last_underscore && !collapsed.is_empty() {
                collapsed.push('_');
            }
            last_underscore = true;
        } else {
            collapsed.push(ch);
            last_underscore = false;
        }
    }
    let trimmed = collapsed.trim_matches('_').to_string();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(32).collect())
}

#[cfg(test)]
mod tests {
    use super::{sanitize, vocab_block};

    #[test]
    fn sanitize_basics() {
        assert_eq!(sanitize("Recipe").as_deref(), Some("recipe"));
        assert_eq!(sanitize("  recipe.  ").as_deref(), Some("recipe"));
        assert_eq!(sanitize("\"recipe\"").as_deref(), Some("recipe"));
        assert_eq!(sanitize("Tech Note").as_deref(), Some("tech_note"));
        assert_eq!(sanitize("restaurant-log").as_deref(), Some("restaurant_log"));
        assert_eq!(sanitize("  ___mixed___  ").as_deref(), Some("mixed"));
    }

    #[test]
    fn sanitize_key_space_is_language_open() {
        // The doc_type key space accepts any script — a CJK label is a
        // first-class key, not something to launder into ASCII (regression:
        // the ASCII-only sanitizer silently collapsed every CJK label into
        // `other`, destroying the whole taxonomy).
        assert_eq!(sanitize("菜谱").as_deref(), Some("菜谱"));
        assert_eq!(sanitize("「食谱」").as_deref(), Some("食谱"));
        assert_eq!(sanitize("宠物饲养。").as_deref(), Some("宠物饲养"));
        assert_eq!(sanitize("菜谱 recipe").as_deref(), Some("菜谱_recipe"));
        // Café — NFC-normalized and lowercased, accents kept.
        assert_eq!(sanitize("Cafe\u{0301}").as_deref(), Some("café"));
    }

    #[test]
    fn sanitize_degenerate_is_none_not_other() {
        // A label with no valid characters must surface as a retryable
        // failure, never silently become "other".
        assert_eq!(sanitize(""), None);
        assert_eq!(sanitize("🎉"), None);
        assert_eq!(sanitize("!!!"), None);
        assert_eq!(sanitize("「」…"), None);
    }

    #[test]
    fn vocab_block_excludes_other_and_offers_seeds() {
        let vocab = vec![
            ("other".to_string(), 69i64),
            ("tech".to_string(), 6i64),
        ];
        let block = vocab_block(&vocab);
        assert!(
            !block.contains("- other"),
            "vocab block must hide the `other` attractor: {block}"
        );
        assert!(block.contains("- tech (6 docs)"));
        // Built-in seeds are always on offer, so a fresh (or collapsed) KB
        // still lands on stable labels.
        assert!(block.contains("- recipe (built-in)"));
        assert!(block.contains("- restaurant_log (built-in)"));

        // A seed already in use shows its count, not "(built-in)".
        let with_seed = vec![("recipe".to_string(), 16i64)];
        let block = vocab_block(&with_seed);
        assert!(block.contains("- recipe (16 docs)"));
        assert!(!block.contains("- recipe (built-in)"));
    }
}
