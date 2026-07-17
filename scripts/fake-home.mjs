#!/usr/bin/env node
/**
 * Fake home simulator (for testing): connects to the relay SSE tunnel, auto-replies to
 * all RPC calls (canned/echo) and serves the binary asset channel from a fixture dir.
 * Usage: node scripts/fake-home.mjs <BASE> <HOME_SECRET> [ASSETS_DIR]
 */
import fs from "node:fs";
import path from "node:path";
const [BASE, SECRET, ASSETS_DIR] = process.argv.slice(2);
if (!BASE || !SECRET) {
  console.error("usage: fake-home.mjs <BASE> <HOME_SECRET> [ASSETS_DIR]");
  process.exit(1);
}

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".txt": "text/plain" };

/** Canned recall hit reused by kb.query / kb.ask (one-shot and streaming). */
const HIT = {
  kind: "chunk",
  path: "test-note.md",
  title: "Test Note",
  headingPath: "Test Note > Section 1",
  content: "This is the canned recall content returned by the fake home.",
  score: 0.032,
  mtime: 1770000000,
  docType: "tech_note",
};

/**
 * Streaming answer channel (docs/ARCHITECTURE.md): chunk the canned answer into
 * `delta` frames, then a terminal `done` frame, and POST them as the SSE body to
 * /api/relay/tunnel/ask/<id>. Mirrors the real engine's streaming synthesize.
 */
async function serveAskStream(id, params) {
  const answer = `About "${params.query}": this is a synthesized streaming answer from the fake home, for link testing only.`;
  const parts = answer.match(/.{1,12}/g) ?? [answer];
  let body = "";
  for (const p of parts) body += `event: delta\ndata: ${JSON.stringify({ text: p })}\n\n`;
  body += `event: done\ndata: ${JSON.stringify({ citations: [{ path: "test-note.md", title: "Test Note" }], hits: [HIT] })}\n\n`;
  console.log("[fake-home] ask-stream:", JSON.stringify(params));
  await fetch(`${BASE}/api/relay/tunnel/ask/${id}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "text/event-stream" },
    body,
  });
}

/**
 * In-memory drafts store (mirrors the home's ~/.homekb/drafts/ over the tunnel).
 * Kept stateful so smoke tests exercise the real save → list → delete cycle.
 */
const drafts = new Map(); // id -> { id, text, editedAt }
let draftSeq = 0;
function draftSave({ id, text }) {
  const key = id && String(id).trim() ? String(id).trim() : `fake-draft-${++draftSeq}`;
  const editedAt = Date.now();
  drafts.set(key, { id: key, text, editedAt });
  return { id: key, editedAt };
}
function draftList() {
  return { drafts: [...drafts.values()].sort((a, b) => b.editedAt - a.editedAt) };
}
function draftDelete({ id }) {
  drafts.delete(id);
  return { id };
}

/** Binary asset channel: read the requested file from ASSETS_DIR and stream it back. */
async function serveAsset(id, assetPath) {
  const post = (body, headers) =>
    fetch(`${BASE}/api/relay/tunnel/asset/${id}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, ...headers },
      body,
    });
  const safe =
    assetPath && !assetPath.startsWith("/") &&
    assetPath.split("/").every((s) => s && s !== "." && s !== "..");
  const file = safe && ASSETS_DIR ? path.join(ASSETS_DIR, assetPath) : null;
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    console.log("[fake-home] asset miss:", assetPath);
    await post(null, { "X-Asset-Error": "not_found" });
    return;
  }
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  console.log("[fake-home] asset:", assetPath, `(${type})`);
  await post(fs.readFileSync(file), { "Content-Type": type });
}

const res = await fetch(`${BASE}/api/relay/tunnel`, {
  headers: { Authorization: `Bearer ${SECRET}` },
});
if (!res.ok) {
  console.error("tunnel connect failed:", res.status);
  process.exit(1);
}
console.log("[fake-home] tunnel connected");

const decoder = new TextDecoder();
let buf = "";
for await (const chunk of res.body) {
  buf += decoder.decode(chunk, { stream: true });
  let idx;
  while ((idx = buf.indexOf("\n\n")) >= 0) {
    const raw = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    const event = /^event: (.+)$/m.exec(raw)?.[1];
    const data = /^data: (.+)$/m.exec(raw)?.[1];
    if (!data) continue;
    if (event === "asset") {
      const { id, path: assetPath } = JSON.parse(data);
      serveAsset(id, assetPath);
      continue;
    }
    if (event !== "rpc") continue;
    const { id, method, params, stream } = JSON.parse(data);
    console.log("[fake-home] rpc:", method, JSON.stringify(params));
    // Streaming ask goes over the dedicated ask channel, not the JSON result channel.
    if (method === "kb.ask" && stream) {
      serveAskStream(id, params);
      continue;
    }
    const canned = {
      "kb.query": { query: params.query, results: [HIT] },
      "kb.ask": {
        answer: `About "${params.query}": this is a synthesized answer from the fake home, for link testing only.`,
        citations: [{ path: "test-note.md", title: "Test Note" }],
        hits: [HIT],
      },
      "kb.read": {
        path: params.path,
        content: `# ${params.path}\n\nThis is the full content returned by the fake home.\n\n- Point one\n- Point two`,
        mtime: 1770000000,
      },
      "kb.write": { path: params.path },
      "kb.create": { path: "new-note.md", title: params.title ?? "New Note" },
      "kb.list": {
        docs: [
          { path: "test-note.md", title: "Test Note", docType: "tech_note", mtime: 1770000000, sizeBytes: 1234 },
          { path: "roast-eggs.md", title: "Roast Eggs", docType: "recipe", mtime: 1769000000, sizeBytes: 890 },
        ],
      },
      "kb.status": {
        available: true,
        generation: 42,
        docs: 72,
        chunks: 512,
        chunksWithVectors: 512,
        pending: 0,
        failures: 0,
        lastCompileAt: Math.floor(Date.now() / 1000) - 120,
        lastCompileHost: "fake-home",
        embeddingModel: "text-embedding-3-small",
      },
      "kb.listTypes": { types: [{ docType: "tech_note", count: 40 }] },
      "kb.suggestions": {
        suggestions: [
          { question: "How does the fake home roast its eggs?", path: "roast-eggs.md", title: "Roast Eggs", mtime: 1769000000 },
          { question: "What is the canned test note about?", path: "test-note.md", title: "Test Note", mtime: 1770000000 },
        ],
      },
      "kb.reindex": { started: true },
      // Share methods (docs/ARCHITECTURE.md "Note sharing") — static shapes
      // matching the contract; policy (password/expiry) is engine-side and not
      // simulated here. `url` mirrors the current-relay composition rule.
      "kb.shareCreate": {
        shareId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        url: `http://localhost:3000/s/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?r=${encodeURIComponent(BASE)}`,
      },
      "kb.shareList": {
        shares: [
          {
            shareId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            path: "test-note.md",
            title: "Test Note",
            createdAt: 1770000000000,
            hasPassword: false,
            url: `http://localhost:3000/s/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?r=${encodeURIComponent(BASE)}`,
          },
        ],
      },
      "kb.shareRevoke": { shareId: params.shareId },
      "kb.shareGet": {
        path: "test-note.md",
        title: "Test Note",
        content: "# Test Note\n\nShared content from the fake home.",
        mtime: 1770000000,
      },
    };
    // Draft methods are stateful (dispatched here, not via the eager `canned`
    // literal, so they only run for their own method).
    const draftHandlers = {
      "kb.draftList": () => draftList(),
      "kb.draftSave": () => draftSave(params),
      "kb.draftDelete": () => draftDelete(params),
    };
    const result = draftHandlers[method]
      ? draftHandlers[method]()
      : (canned[method] ?? { echo: { method, params }, fake: true });
    await fetch(`${BASE}/api/relay/tunnel/result`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id, ok: true, result }),
    });
  }
}
console.log("[fake-home] tunnel closed");
