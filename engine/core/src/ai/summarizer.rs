//! OpenAI chat-completion client for generating per-document summaries
//! and one suggested question per document.
//!
//! Both come back from a single chat call as a JSON object
//! `{"summary": "...", "question": "..."}` — the suggested question rides
//! along with the summary for free (the full content is already being
//! sent). If the model ever returns non-JSON, we degrade gracefully:
//! the whole text becomes the summary and the question stays `None`
//! (the pipeline's backfill pass will retry it on a later run).

use anyhow::{Context, Result};
use async_openai::{
    Client,
    types::chat::{
        ChatCompletionRequestSystemMessageArgs, ChatCompletionRequestUserMessageArgs,
        CreateChatCompletionRequestArgs,
    },
};

const SYSTEM_PROMPT: &str = "You analyze one markdown document from a personal \
knowledge base. Respond with a strict JSON object containing exactly two string \
fields:\n\
- \"summary\": 3-5 sentences capturing what the document is about, the main \
topics it covers, and any decisions or conclusions stated.\n\
- \"question\": one natural, curiosity-invoking question that this document \
answers well — phrased the way the document's owner would ask it when trying \
to recall this content later. Write the question in the same language as the \
document. Keep it under 80 characters. Do not mention \"the document\" or \
\"the author\" in the question.\n\
Output ONLY the JSON object — no markdown fences, no extra text.";

const QUESTION_PROMPT: &str = "You write one suggested question for a markdown \
document in a personal knowledge base. Produce a single natural, \
curiosity-invoking question that the document answers well — phrased the way \
the document's owner would ask it when trying to recall this content later. \
Write the question in the same language as the document. Keep it under 80 \
characters. Do not mention \"the document\" or \"the author\". Output only the \
question text — no quotes, no preamble.";

/// Maximum stored length of a suggested question, in characters.
/// Anything longer is almost certainly the model rambling; we drop it and
/// let the backfill retry instead of storing junk.
const MAX_QUESTION_CHARS: usize = 200;

type OpenAIClient = Client<async_openai::config::OpenAIConfig>;

/// Summary + suggested question produced by one [`Summarizer::digest`] call.
#[derive(Debug, Clone)]
pub struct DocDigest {
    pub summary: String,
    /// `None` when the model reply could not be parsed as JSON — the
    /// pipeline backfill regenerates it on a later run.
    pub question: Option<String>,
}

pub struct Summarizer {
    client: OpenAIClient,
    model: String,
}

impl Summarizer {
    pub fn new(api_key: &str, model: impl Into<String>) -> Self {
        let cfg = async_openai::config::OpenAIConfig::default().with_api_key(api_key);
        Self {
            client: Client::with_config(cfg),
            model: model.into(),
        }
    }

    /// Generate the summary and the suggested question in one chat call.
    pub async fn digest(&self, content: &str) -> Result<DocDigest> {
        let raw = self
            .chat(SYSTEM_PROMPT, truncate(content), 400, 5)
            .await
            .context("digest chat call failed")?;
        Ok(parse_digest(&raw))
    }

    /// Generate only the suggested question (backfill path: the summary is
    /// current but `suggested_question` is still NULL).
    pub async fn question_only(&self, content: &str) -> Result<String> {
        let raw = self
            .chat(QUESTION_PROMPT, truncate(content), 120, 4)
            .await
            .context("question chat call failed")?;
        sanitize_question(&raw).context("model returned an unusable question")
    }

    async fn chat(
        &self,
        system: &str,
        user: &str,
        max_tokens: u32,
        max_attempts: u32,
    ) -> Result<String> {
        let mut attempt = 0u32;
        loop {
            let req = CreateChatCompletionRequestArgs::default()
                .model(&self.model)
                .temperature(0.2)
                .max_tokens(max_tokens)
                .messages([
                    ChatCompletionRequestSystemMessageArgs::default()
                        .content(system)
                        .build()?
                        .into(),
                    ChatCompletionRequestUserMessageArgs::default()
                        .content(user.to_string())
                        .build()?
                        .into(),
                ])
                .build()?;

            match self.client.chat().create(req).await {
                Ok(resp) => {
                    let choice = resp
                        .choices
                        .into_iter()
                        .next()
                        .context("no choices in chat completion")?;
                    let text = choice.message.content.unwrap_or_default();
                    return Ok(text.trim().to_string());
                }
                Err(err) => {
                    attempt += 1;
                    if attempt >= max_attempts {
                        return Err::<String, _>(anyhow::anyhow!(err))
                            .context("chat.create failed after retries");
                    }
                    let delay_ms = 500u64 * (1 << (attempt - 1));
                    tracing::warn!(
                        "summarizer chat attempt {} failed: {}; retrying in {}ms",
                        attempt,
                        err,
                        delay_ms
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                }
            }
        }
    }
}

/// Defensive input truncation: chat completion has its own context window.
/// For very large docs we send the first ~48 KB; neither the summary nor
/// the question needs to be exhaustive.
fn truncate(content: &str) -> &str {
    if content.len() > 48_000 {
        &content[..floor_char_boundary(content, 48_000)]
    } else {
        content
    }
}

/// Parse the model reply into a [`DocDigest`]. Tolerates ```json fences.
/// Non-JSON replies degrade to summary-only (question = None).
fn parse_digest(raw: &str) -> DocDigest {
    let stripped = strip_code_fence(raw.trim());

    #[derive(serde::Deserialize)]
    struct Wire {
        summary: Option<String>,
        question: Option<String>,
    }

    match serde_json::from_str::<Wire>(stripped) {
        Ok(w) => {
            let summary = w
                .summary
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                // JSON parsed but no usable summary field: fall back to raw.
                .unwrap_or_else(|| raw.trim().to_string());
            DocDigest {
                summary,
                question: w.question.as_deref().and_then(sanitize_question),
            }
        }
        Err(_) => {
            tracing::warn!("digest reply was not JSON; storing it as summary, question deferred");
            DocDigest {
                summary: raw.trim().to_string(),
                question: None,
            }
        }
    }
}

/// Normalize a question candidate: trim whitespace/wrapping quotes, reject
/// empty or absurdly long output.
fn sanitize_question(raw: &str) -> Option<String> {
    let q = raw
        .trim()
        .trim_matches(|c: char| c == '"' || c == '\u{201c}' || c == '\u{201d}')
        .trim()
        .to_string();
    if q.is_empty() || q.chars().count() > MAX_QUESTION_CHARS {
        return None;
    }
    Some(q)
}

/// Strip a wrapping markdown code fence (```json ... ``` or ``` ... ```).
fn strip_code_fence(s: &str) -> &str {
    let s = s.trim();
    let Some(rest) = s.strip_prefix("```") else {
        return s;
    };
    // Drop the info string (e.g. "json") up to the first newline.
    let rest = match rest.find('\n') {
        Some(i) => &rest[i + 1..],
        None => rest,
    };
    rest.strip_suffix("```").unwrap_or(rest).trim()
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::{parse_digest, sanitize_question, strip_code_fence};

    #[test]
    fn digest_parses_plain_json() {
        let d = parse_digest(r#"{"summary": "About X.", "question": "Why X?"}"#);
        assert_eq!(d.summary, "About X.");
        assert_eq!(d.question.as_deref(), Some("Why X?"));
    }

    #[test]
    fn digest_parses_fenced_json() {
        let d = parse_digest("```json\n{\"summary\": \"S\", \"question\": \"Q?\"}\n```");
        assert_eq!(d.summary, "S");
        assert_eq!(d.question.as_deref(), Some("Q?"));
    }

    #[test]
    fn digest_falls_back_to_plain_text() {
        let d = parse_digest("Just a prose summary, no JSON at all.");
        assert_eq!(d.summary, "Just a prose summary, no JSON at all.");
        assert!(d.question.is_none());
    }

    #[test]
    fn digest_tolerates_missing_question() {
        let d = parse_digest(r#"{"summary": "Only summary."}"#);
        assert_eq!(d.summary, "Only summary.");
        assert!(d.question.is_none());
    }

    #[test]
    fn digest_ignores_empty_question() {
        let d = parse_digest(r#"{"summary": "S", "question": "   "}"#);
        assert!(d.question.is_none());
    }

    #[test]
    fn question_sanitization() {
        assert_eq!(sanitize_question("  \"Why X?\"  ").as_deref(), Some("Why X?"));
        assert_eq!(sanitize_question("\u{201c}为什么要懒加载？\u{201d}").as_deref(), Some("为什么要懒加载？"));
        assert!(sanitize_question("").is_none());
        assert!(sanitize_question(&"x".repeat(300)).is_none());
    }

    #[test]
    fn fence_stripping() {
        assert_eq!(strip_code_fence("```json\n{}\n```"), "{}");
        assert_eq!(strip_code_fence("```\n{}\n```"), "{}");
        assert_eq!(strip_code_fence("{}"), "{}");
    }
}
