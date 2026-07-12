import { CORS_HEADERS, corsPreflight, requestOrigin } from "@/lib/relay/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RFC 8414 授权服务器元数据 */
export function GET(req: Request) {
  const origin = requestOrigin(req);
  return Response.json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/api/oauth/token`,
      registration_endpoint: `${origin}/api/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["kb"],
    },
    { headers: CORS_HEADERS },
  );
}

export function OPTIONS() {
  return corsPreflight();
}
