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
 * Streaming answer channel (docs/ARCHITECTURE.md): deliver the canned answer over
 * the **chunked** ask channel — ordered POSTs to /api/relay/tunnel/ask/<id> with
 * X-Ask-Seq (+ X-Ask-Fin on the last), mirroring the real engine's chunked
 * delivery. Delta frames split across chunks so smoke tests see true increments.
 */
async function serveAskStream(id, params) {
  const answer = `About "${params.query}": this is a synthesized streaming answer from the fake home, for link testing only.`;
  const parts = answer.match(/.{1,12}/g) ?? [answer];
  const frames = parts.map((p) => `event: delta\ndata: ${JSON.stringify({ text: p })}\n\n`);
  const doneFrame = `event: done\ndata: ${JSON.stringify({ citations: [{ path: "test-note.md", title: "Test Note" }], hits: [HIT] })}\n\n`;
  const mid = Math.ceil(frames.length / 2);
  const chunks = [frames.slice(0, mid).join(""), frames.slice(mid).join("") + doneFrame];
  console.log("[fake-home] ask-stream:", JSON.stringify(params));
  for (let seq = 0; seq < chunks.length; seq++) {
    const fin = seq === chunks.length - 1;
    const res = await fetch(`${BASE}/api/relay/tunnel/ask/${id}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "text/event-stream",
        "X-Ask-Seq": String(seq),
        ...(fin ? { "X-Ask-Fin": "1" } : {}),
      },
      body: chunks[seq],
    });
    if (!res.ok) {
      console.log(`[fake-home] ask chunk ${seq} NACKed: HTTP ${res.status}`);
      return;
    }
  }
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

/**
 * In-memory AI config (docs/ARCHITECTURE.md "Settings over RPC"). Stateful so
 * smoke tests exercise the masked read → write → masked echo cycle, including
 * the key ↔ endpoint binding rule (provider or baseUrl change drops the key).
 * Keys are stored as a boolean only — this fake never sees or returns one.
 */
const aiConfig = {
  embedding: { provider: "openai", model: "text-embedding-3-small", keyPresent: true, configured: true },
  summary: { provider: "openai", model: "gpt-4o-mini", keyPresent: true, configured: true },
  ask: { provider: "openai", model: "gpt-4o-mini", keyPresent: false, configured: false },
};
function configGet() {
  return {
    root: "/home/fake/.homekb",
    notesDir: "/home/fake/.homekb/notes",
    configPath: "/home/fake/.homekb/config.toml",
    ai: structuredClone(aiConfig),
  };
}
const PRESET_MODELS = {
  embedding: { openai: "text-embedding-3-small", gemini: "gemini-embedding-001", voyage: "voyage-4", cohere: "embed-v4.0", qwen: "text-embedding-v4" },
  chat: { openai: "gpt-4o-mini", gemini: "gemini-flash-lite-latest", deepseek: "deepseek-chat", qwen: "qwen-flash" },
};
function configSetAi({ section, provider, apiKey, model, baseUrl, dim }) {
  if (!["embedding", "summary", "ask"].includes(section)) {
    throw new Error(`unknown config section "${section}"`);
  }
  const p = (provider ?? "").trim();
  if (section === "ask" && !p) {
    aiConfig.ask = { provider: "openai", model: PRESET_MODELS.chat.openai, keyPresent: false, configured: false };
    return { ai: structuredClone(aiConfig) };
  }
  const prev = aiConfig[section];
  const requestedBase = (baseUrl ?? "").trim().replace(/\/+$/, "") || undefined;
  const providerChanged = prev.provider !== p;
  const baseChanged = requestedBase !== undefined && requestedBase !== prev.baseUrl;
  const presets = section === "embedding" ? PRESET_MODELS.embedding : PRESET_MODELS.chat;
  const next = {
    provider: p,
    model: (model ?? "").trim() || presets[p] || "",
    // Key ↔ endpoint binding: a changed provider or base URL drops the stored
    // key unless this write supplies a new one.
    keyPresent: Boolean((apiKey ?? "").trim()) || (!providerChanged && !baseChanged && prev.keyPresent),
    configured: true,
  };
  if (requestedBase !== undefined) next.baseUrl = requestedBase;
  else if (!providerChanged && prev.baseUrl) next.baseUrl = prev.baseUrl;
  if (section === "embedding") {
    if (dim) next.dim = dim;
    else if (!providerChanged && prev.dim) next.dim = prev.dim;
  }
  aiConfig[section] = next;
  return { ai: structuredClone(aiConfig) };
}

/**
 * Binary asset channel, upload direction: claim the pending body from the relay
 * (GET /tunnel/upload/<id>), write it under ASSETS_DIR with the engine's
 * collision-avoid convention, and report the final path via /tunnel/result.
 */
async function serveAssetUpload(id, suggestedPath) {
  const respond = (ok, resultOrError) =>
    fetch(`${BASE}/api/relay/tunnel/result`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify(ok ? { id, ok: true, result: resultOrError } : { id, ok: false, error: resultOrError }),
    });
  const parts = (suggestedPath ?? "").split("/");
  const safe =
    parts.length === 2 &&
    ["images", "attachments"].includes(parts[0]) &&
    parts[1] && parts[1] !== "." && parts[1] !== "..";
  if (!safe || !ASSETS_DIR) {
    console.log("[fake-home] asset upload rejected:", suggestedPath);
    await respond(false, { code: "asset_write_failed", message: "bad path" });
    return;
  }
  const res = await fetch(`${BASE}/api/relay/tunnel/upload/${id}`, {
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  if (!res.ok) {
    console.log("[fake-home] upload claim failed:", res.status);
    await respond(false, { code: "asset_write_failed", message: `claim HTTP ${res.status}` });
    return;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const dir = path.join(ASSETS_DIR, parts[0]);
  fs.mkdirSync(dir, { recursive: true });
  const dot = parts[1].lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [parts[1].slice(0, dot), parts[1].slice(dot)] : [parts[1], ""];
  let name = `${stem}${ext}`;
  for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${stem}-${n}${ext}`;
  fs.writeFileSync(path.join(dir, name), bytes);
  const finalPath = `${parts[0]}/${name}`;
  console.log("[fake-home] asset upload:", suggestedPath, "→", finalPath, `(${bytes.length} bytes)`);
  await respond(true, { path: finalPath });
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
    if (event === "assetUpload") {
      const { id, path: assetPath } = JSON.parse(data);
      serveAssetUpload(id, assetPath);
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
      "kb.configGet": () => configGet(),
      "kb.configSetAi": () => configSetAi(params),
    };
    let body;
    try {
      const result = draftHandlers[method]
        ? draftHandlers[method]()
        : (canned[method] ?? { echo: { method, params }, fake: true });
      body = { id, ok: true, result };
    } catch (e) {
      body = { id, ok: false, error: { code: "rpc_error", message: String(e?.message ?? e) } };
    }
    await fetch(`${BASE}/api/relay/tunnel/result`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }
}
console.log("[fake-home] tunnel closed");
