export interface KbHit {
  kind: "chunk" | "doc" | "doc_full";
  path: string;
  title: string;
  headingPath?: string | null;
  content: string;
  score: number;
  mtime: number;
  docType?: string | null;
  /** In group mode: number of chunks merged into this result */
  matches?: number;
}

export interface KbAnswer {
  answer: string;
  citations: { path: string; title: string }[];
  hits?: KbHit[];
}

/** `kb.configGet` result (docs "Settings over RPC") — masked, never a key. */
export interface KbConfigData {
  root: string;
  notesDir: string;
  configPath: string;
  ai: {
    embedding: KbAiEndpoint;
    summary: KbAiEndpoint;
    ask: KbAiEndpoint;
  };
}

export interface KbAiEndpoint {
  provider: string;
  model: string;
  keyPresent: boolean;
  /** Whether the section exists in config.toml ([ask]: false = summary fallback). */
  configured: boolean;
  baseUrl?: string;
  dim?: number;
}

export interface KbStatusData {
  available?: boolean;
  generation?: number;
  docs?: number;
  chunks?: number;
  chunksWithVectors?: number;
  pending?: number;
  failures?: number;
  lastCompileAt?: number | null;
  lastCompileHost?: string | null;
  embeddingModel?: string | null;
}

export interface DocMeta {
  path: string;
  title: string;
  docType?: string | null;
  mtime: number;
  sizeBytes: number;
}

/** Home-screen "Try asking" entry: an auto-generated question a recently updated doc answers well. */
export interface KbSuggestion {
  question: string;
  path: string;
  title?: string | null;
  mtime: number;
}

/**
 * A not-yet-published note. Drafts live on the home device (`~/.homekb/drafts/`)
 * and are shared across every paired client via the `kb.draft*` RPCs — not kept
 * in per-device local storage. `id` is the home-side draft id (its filename stem).
 */
export interface Draft {
  id: string;
  text: string;
  editedAt: number; // epoch ms
}

/**
 * One public share link (docs/ARCHITECTURE.md "Note sharing"). Records live on
 * the home device (`~/.homekb/shares.json`) — password/expiry/revocation are
 * all enforced there; the relay only routes. `url` is composed against the
 * relay the home is registered with *now* (absent when unregistered), so it is
 * always the link that works — even after the home switched services.
 */
export interface ShareMeta {
  shareId: string;
  path: string;
  title?: string | null;
  createdAt: number; // epoch ms
  expiresAt?: number | null; // epoch ms; absent = never expires
  hasPassword: boolean;
  url?: string | null;
}

/** `kb.shareCreate` result. */
export interface CreatedShare {
  shareId: string;
  url: string;
  expiresAt?: number | null;
}

/*
 * Surfaces are URL-owned (no view enum): tabs are path routes (/search, /new,
 * /new/drafts, /status, /remote, /shares, desktop-only /settings), dynamic
 * overlays are hash params (`/search#doc=<path>`, `/new#draft=<id>`) so the
 * system back gesture closes them. See lib/client/hash-route.ts and app/(app)/.
 */

/** What the engine decided to render for the submitted query (docs/ARCHITECTURE.md
 *  "Auto mode"): a streaming AI answer or a note list. There is no user-facing
 *  mode toggle — the ask router judges the intent per query. */
export type ResultKind = "answer" | "list";
/** Progressive ask stages, mapped 1:1 onto stream-frame arrivals (docs
 *  "First-paint batch"): submit→hits = vector search, hits→route outcome =
 *  query analysis, sources→done = answer synthesis. Null when idle/terminal. */
export type AskStage = "searching" | "thinking" | "answering";
/** "streaming" = answer tokens arriving (answer results only); "done" = complete. */
export type RecallPhase = "idle" | "searching" | "streaming" | "done";

/** Product-defining connection language (design: green online / amber connecting / orange offline). */
export type ConnState = "online" | "connecting" | "offline";
