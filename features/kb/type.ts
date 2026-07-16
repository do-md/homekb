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
 * Views. "settings" and the full "remote" pairing hub are desktop-mode surfaces;
 * the web build shows a reduced "remote" (current connection + disconnect) and no settings.
 * "new" and "drafts" are focused modes without the pill nav (design 5a/5b).
 */
export type KbView =
  | "recall"
  | "reader"
  | "new"
  | "drafts"
  | "status"
  | "remote"
  | "settings";

export type RecallMode = "list" | "answer";
/** "streaming" = answer tokens arriving (Answer mode only); "done" = complete. */
export type RecallPhase = "idle" | "searching" | "streaming" | "done";

/** Product-defining connection language (design: green online / amber connecting / orange offline). */
export type ConnState = "online" | "connecting" | "offline";
