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

const SYSTEM_PROMPT: &str = "You categorize markdown documents in a personal \
knowledge base.

You will be shown:
1. A list of categories that already exist in this KB, with how many docs \
fall under each.
2. The title, summary, and a content excerpt from a document.

Pick the BEST category for this document.

Rules:
- STRONGLY prefer reusing an existing category if it's a reasonable fit. \
Reuse is the default; new categories should be rare.
- Only invent a new category when no existing one applies.
- Category names: short, lowercase, snake_case (e.g. recipe, tech_note, \
restaurant_log, diary, travel_log, code_snippet, reference, book_note).
- Output ONLY the category name. No explanation, no quotes, no markdown, \
no trailing punctuation.";

pub struct Categorizer {
    client: OpenAIClient,
    model: String,
}

impl Categorizer {
    pub fn new(api_key: &str, model: impl Into<String>) -> Self {
        let cfg = async_openai::config::OpenAIConfig::default().with_api_key(api_key);
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
        let vocab_block = if vocab.is_empty() {
            "(no existing categories yet — this is one of the first documents)".to_string()
        } else {
            vocab
                .iter()
                .map(|(name, c)| format!("- {name} ({c})"))
                .collect::<Vec<_>>()
                .join("\n")
        };

        let user_msg = format!(
            "Existing categories (by frequency):\n{vocab_block}\n\n\
             Document title: {title}\n\
             Summary: {summary}\n\n\
             Content excerpt:\n{content_preview}\n\n\
             Category:",
            title = if title.is_empty() { "(none)" } else { title },
        );

        let mut attempt = 0u32;
        loop {
            let req = CreateChatCompletionRequestArgs::default()
                .model(&self.model)
                .temperature(0.1)
                .max_tokens(16u32)
                .messages([
                    ChatCompletionRequestSystemMessageArgs::default()
                        .content(SYSTEM_PROMPT)
                        .build()?
                        .into(),
                    ChatCompletionRequestUserMessageArgs::default()
                        .content(user_msg.clone())
                        .build()?
                        .into(),
                ])
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
                    return Ok(sanitize(&raw));
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

/// Normalize raw LLM output to `lowercase_snake_case`. Strips whitespace,
/// quotes, trailing punctuation. Replaces interior whitespace and dashes
/// with underscores. Caps length at 32 chars.
fn sanitize(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches(|c: char| c == '"' || c == '\'' || c == '.');
    let mut out = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        match ch {
            'A'..='Z' => out.extend(ch.to_lowercase()),
            'a'..='z' | '0'..='9' | '_' => out.push(ch),
            ' ' | '-' | '\t' => out.push('_'),
            _ => {} // drop punctuation, emoji, CJK, etc.
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
        return "other".to_string();
    }
    trimmed.chars().take(32).collect()
}

#[cfg(test)]
mod tests {
    use super::sanitize;
    #[test]
    fn sanitize_basics() {
        assert_eq!(sanitize("Recipe"), "recipe");
        assert_eq!(sanitize("  recipe.  "), "recipe");
        assert_eq!(sanitize("\"recipe\""), "recipe");
        assert_eq!(sanitize("Tech Note"), "tech_note");
        assert_eq!(sanitize("restaurant-log"), "restaurant_log");
        assert_eq!(sanitize("  ___mixed___  "), "mixed");
        assert_eq!(sanitize(""), "other");
        assert_eq!(sanitize("🎉"), "other");
    }
}
