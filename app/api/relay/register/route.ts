import { nanoid } from "nanoid";
import { relayDb } from "@/lib/relay/db";
import { jsonError, randomToken, sha256hex } from "@/lib/relay/auth";

export const runtime = "nodejs";

/** Home device registration: → {homeId, homeSecret} (homeSecret is returned in plaintext only once) */
export async function POST(req: Request) {
  let name = "";
  try {
    const body = await req.json();
    if (typeof body?.name === "string") name = body.name.slice(0, 64);
  } catch {
    // empty body is also allowed
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
