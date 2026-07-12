export interface KbHit {
  kind: "chunk" | "doc" | "doc_full";
  path: string;
  title: string;
  headingPath?: string | null;
  content: string;
  score: number;
  mtime: number;
  docType?: string | null;
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

/** "settings" 仅桌面模式（Tauri）可达，Web 版不渲染入口。 */
export type KbView = "recall" | "reader" | "new" | "status" | "settings";
export type RecallMode = "list" | "answer";
export type RecallPhase = "idle" | "searching" | "done";
