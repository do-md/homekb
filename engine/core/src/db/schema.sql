-- Schema version 1
-- All DDL is idempotent (IF NOT EXISTS) so this file is the migration too.

CREATE TABLE IF NOT EXISTS index_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS docs (
    id                INTEGER PRIMARY KEY,
    path              TEXT NOT NULL UNIQUE,
    title             TEXT,
    content_hash      TEXT NOT NULL,
    summary           TEXT,
    summary_src_hash  TEXT,
    doc_type          TEXT,
    size_bytes        INTEGER NOT NULL,
    mtime             INTEGER NOT NULL,
    indexed_at        INTEGER NOT NULL,
    index_state       TEXT NOT NULL DEFAULT 'ok'
);
CREATE INDEX IF NOT EXISTS idx_docs_path  ON docs(path);
CREATE INDEX IF NOT EXISTS idx_docs_state ON docs(index_state) WHERE index_state != 'ok';
-- idx_docs_type is created in code AFTER the v1→v2 migration ensures
-- the doc_type column exists.

CREATE TABLE IF NOT EXISTS chunks (
    id            INTEGER PRIMARY KEY,
    doc_id        INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    chunk_index   INTEGER NOT NULL,
    heading_path  TEXT,
    content       TEXT NOT NULL,
    content_hash  TEXT NOT NULL,
    start_line    INTEGER,
    end_line      INTEGER,
    token_count   INTEGER,
    embed_pending INTEGER NOT NULL DEFAULT 0,
    UNIQUE(doc_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc  ON chunks(doc_id);
CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);

CREATE TABLE IF NOT EXISTS failures (
    id           INTEGER PRIMARY KEY,
    path         TEXT NOT NULL,
    op           TEXT NOT NULL,
    error        TEXT NOT NULL,
    attempted_at INTEGER NOT NULL,
    retry_count  INTEGER NOT NULL DEFAULT 0
);

-- vec0 virtual tables: dimensions are filled in by db::init using the
-- configured embedding_dim. We do NOT create them here because vec0
-- requires the dimension as a literal in the CREATE statement.

-- Triggers that cascade deletes into virtual tables. Virtual tables
-- do not honor foreign-key cascade, so we wire it manually.
CREATE TRIGGER IF NOT EXISTS docs_delete_cleans_vecs
AFTER DELETE ON docs
BEGIN
    DELETE FROM vec_docs   WHERE rowid = OLD.id;
    DELETE FROM vec_chunks WHERE rowid IN (SELECT id FROM chunks WHERE doc_id = OLD.id);
END;

CREATE TRIGGER IF NOT EXISTS chunks_delete_cleans_vec
AFTER DELETE ON chunks
BEGIN
    DELETE FROM vec_chunks WHERE rowid = OLD.id;
END;
