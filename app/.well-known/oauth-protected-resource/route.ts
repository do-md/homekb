import { CORS_HEADERS, corsPreflight, requestOrigin } from "@/lib/relay/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RFC 9728 受保护资源元数据 */
export function GET(req: Request) {
  const origin = requestOrigin(req);
  return Response.json(
    {
      resource: origin,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: ["kb"],
    },
    { headers: CORS_HEADERS },
  );
}

export function OPTIONS() {
  return corsPreflight();
}
