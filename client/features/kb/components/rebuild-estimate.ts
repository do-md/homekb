/**
 * Rebuild cost estimation shared by the desktop Settings rebuild card (Tauri
 * `index_stats`) and the web Settings rebuild card (`kb.status` over RPC).
 */

/**
 * Rough embedding price per 1M input tokens (USD) by model, for the rebuild
 * estimate. Order-of-magnitude only — actual token counts vary by content.
 */
export const EMBEDDING_RATE_PER_M: Record<string, number> = {
  "text-embedding-3-small": 0.02,
  "text-embedding-3-large": 0.13,
  "gemini-embedding-001": 0.15,
  "voyage-4": 0.06,
  "voyage-4-lite": 0.02,
  "voyage-4-large": 0.12,
  "embed-v4.0": 0.1,
  "text-embedding-v4": 0.07, // DashScope ~0.5 CNY per 1M tokens
};

/** Estimate the embedding cost of a full reindex from chunk/doc counts. */
export function estimateReindexCost(chunks: number, docs: number, model: string): string {
  // Heuristic: chunk pool (~600 tok/chunk) + doc-summary pool (~130 tok/doc).
  const tokens = chunks * 600 + docs * 130;
  const rate = EMBEDDING_RATE_PER_M[model] ?? 0.1;
  const usd = (tokens / 1_000_000) * rate;
  if (usd < 0.01) return "<$0.01";
  return `≈ $${usd.toFixed(2)}`;
}
