//! OpenAI chat-completion client for generating per-document summaries.

use anyhow::{Context, Result};
use async_openai::{
    Client,
    types::chat::{
        ChatCompletionRequestSystemMessageArgs, ChatCompletionRequestUserMessageArgs,
        CreateChatCompletionRequestArgs,
    },
};

const SYSTEM_PROMPT: &str = "You write concise summaries of markdown documents. \
Produce 3-5 sentences that capture what the document is about, the main topics it covers, \
and any decisions or conclusions stated. Output only the summary text — no preamble, \
no markdown headings, no bullet lists.";

type OpenAIClient = Client<async_openai::config::OpenAIConfig>;

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

    pub async fn summarize(&self, content: &str) -> Result<String> {
        // Defensive: chat completion has its own context window. For very
        // large docs we send the first ~12000 chars; the summary doesn't
        // need to be exhaustive.
        let truncated = if content.len() > 48_000 {
            &content[..floor_char_boundary(content, 48_000)]
        } else {
            content
        };

        let mut attempt = 0u32;
        loop {
            let req = CreateChatCompletionRequestArgs::default()
                .model(&self.model)
                .temperature(0.2)
                .max_tokens(300u32)
                .messages([
                    ChatCompletionRequestSystemMessageArgs::default()
                        .content(SYSTEM_PROMPT)
                        .build()?
                        .into(),
                    ChatCompletionRequestUserMessageArgs::default()
                        .content(truncated.to_string())
                        .build()?
                        .into(),
                ])
                .build()?;

            match self.client.chat().create(req).await {
                Ok(resp) => {
                    let choice = resp.choices.into_iter().next()
                        .context("no choices in chat completion")?;
                    let text = choice.message.content.unwrap_or_default();
                    return Ok(text.trim().to_string());
                }
                Err(err) => {
                    attempt += 1;
                    if attempt >= 5 {
                        return Err::<String, _>(anyhow::anyhow!(err))
                            .context("chat.create failed after retries");
                    }
                    let delay_ms = 500u64 * (1 << (attempt - 1));
                    tracing::warn!("summarize attempt {} failed: {}; retrying in {}ms", attempt, err, delay_ms);
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                }
            }
        }
    }
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    if i >= s.len() { return s.len(); }
    while !s.is_char_boundary(i) { i -= 1; }
    i
}
