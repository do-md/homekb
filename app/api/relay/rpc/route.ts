import { authGrant, jsonError } from "@/lib/relay/auth";
import { hub, RPC_METHODS, RpcHubError } from "@/lib/relay/hub";

export const runtime = "nodejs";

/** 远端客户端 RPC：经隧道转发到家设备执行 */
export async function POST(req: Request) {
  const grant = authGrant(req);
  if (!grant) return jsonError(401, "unauthorized");

  let body: { method?: string; params?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "invalid_json");
  }
  const method = String(body.method || "");
  if (!RPC_METHODS.has(method)) return jsonError(400, "unknown_method");

  try {
    const result = await hub().call(grant.home_id, method, body.params ?? {});
    return Response.json({ ok: true, result });
  } catch (e) {
    if (e instanceof RpcHubError) {
      const status =
        e.code === "home_offline" ? 502 : e.code === "timeout" ? 504 : 500;
      return Response.json(
        { ok: false, error: e.code, message: e.message, detail: e.detail },
        { status },
      );
    }
    return jsonError(500, "internal_error");
  }
}
