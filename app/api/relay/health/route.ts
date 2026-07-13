import { authGrant, jsonError } from "@/lib/relay/auth";
import { hub } from "@/lib/relay/hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Client health check: whether the home device is online */
export async function GET(req: Request) {
  const grant = authGrant(req);
  if (!grant) return jsonError(401, "unauthorized");
  return Response.json({ ok: true, online: hub().online(grant.home_id) });
}
