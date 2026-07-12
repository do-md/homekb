import { nanoid } from "nanoid";
import { relayDb } from "@/lib/relay/db";
import { jsonError, randomToken, sha256hex } from "@/lib/relay/auth";

export const runtime = "nodejs";

/** 家设备注册：→ {homeId, homeSecret}（homeSecret 明文只返回这一次） */
export async function POST(req: Request) {
  let name = "";
  try {
    const body = await req.json();
    if (typeof body?.name === "string") name = body.name.slice(0, 64);
  } catch {
    // 空 body 也允许
  }
  const homeId = "hm_" + nanoid(10);
  const homeSecret = randomToken("hks_");
  relayDb()
    .prepare("INSERT INTO homes (id, name, secret_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(homeId, name, sha256hex(homeSecret), Date.now());
  return Response.json({ ok: true, homeId, homeSecret });
}

export function GET() {
  return jsonError(405, "method_not_allowed");
}
