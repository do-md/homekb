#!/usr/bin/env node
/**
 * 假家端模拟器（测试用）：连中继 SSE 隧道，自动应答所有 RPC（echo 收到的 method/params）。
 * 用法：node scripts/fake-home.mjs <BASE> <HOME_SECRET>
 */
const [BASE, SECRET] = process.argv.slice(2);
if (!BASE || !SECRET) {
  console.error("usage: fake-home.mjs <BASE> <HOME_SECRET>");
  process.exit(1);
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
    if (event !== "rpc" || !data) continue;
    const { id, method, params } = JSON.parse(data);
    console.log("[fake-home] rpc:", method, JSON.stringify(params));
    const HIT = {
      kind: "chunk",
      path: "测试笔记.md",
      title: "测试笔记",
      headingPath: "测试笔记 > 第一节",
      content: "这是假家端返回的召回内容。",
      score: 0.032,
      mtime: 1770000000,
      docType: "tech_note",
    };
    const canned = {
      "kb.query": { query: params.query, results: [HIT] },
      "kb.ask": {
        answer: `关于「${params.query}」：这是假家端综合出的答案，仅用于链路测试。`,
        citations: [{ path: "测试笔记.md", title: "测试笔记" }],
        hits: [HIT],
      },
      "kb.read": {
        path: params.path,
        content: `# ${params.path}\n\n这是假家端返回的整篇内容。\n\n- 要点一\n- 要点二`,
        mtime: 1770000000,
      },
      "kb.write": { path: params.path },
      "kb.create": { path: "新笔记.md", title: params.title ?? "新笔记" },
      "kb.list": {
        docs: [
          { path: "测试笔记.md", title: "测试笔记", docType: "tech_note", mtime: 1770000000, sizeBytes: 1234 },
          { path: "烤鸡蛋.md", title: "烤鸡蛋", docType: "recipe", mtime: 1769000000, sizeBytes: 890 },
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
      "kb.reindex": { started: true },
    };
    const result = canned[method] ?? { echo: { method, params }, fake: true };
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
