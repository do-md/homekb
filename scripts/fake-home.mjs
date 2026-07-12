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
    const result = {
      echo: { method, params },
      fake: true,
      ...(method === "kb.query"
        ? {
            query: params.query,
            results: [
              {
                kind: "chunk",
                path: "测试笔记.md",
                title: "测试笔记",
                headingPath: "测试笔记 > 第一节",
                content: "这是假家端返回的召回内容。",
                score: 0.032,
                mtime: 1770000000,
                docType: "tech_note",
              },
            ],
          }
        : {}),
    };
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
