import { authHome, jsonError } from "@/lib/relay/auth";
import { hub, type RpcError } from "@/lib/relay/hub";

export const runtime = "nodejs";

/** Home device upstream: return RPC execution result */
export async function POST(req: Request) {
  const home = authHome(req);
  if (!home) return jsonError(401, "unauthorized");

  let body: { id?: string; ok?: boolean; result?: unknown; error?: RpcError };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "invalid_json");
  }
  if (typeof body.id !== "string" || typeof body.ok !== "boolean") {
    return jsonError(400, "missing_fields");
  }
  hub().resolveResult(home.id, body.id, body.ok, body.result, body.error);
  return new Response(null, { status: 204 });
}
