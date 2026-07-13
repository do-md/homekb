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

/** "settings" is only reachable in desktop mode (Tauri); the web version does not render its nav entry. */
export type KbView = "recall" | "reader" | "new" | "status" | "settings";
export type RecallMode = "list" | "answer";
export type RecallPhase = "idle" | "searching" | "done";
