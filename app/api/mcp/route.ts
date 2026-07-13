import { authGrant } from "@/lib/relay/auth";
import { handleMcpMessage } from "@/lib/mcp/handler";
import { CORS_HEADERS, corsPreflight, requestOrigin } from "@/lib/relay/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(req: Request): Response {
  const origin = requestOrigin(req);
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "Unauthorized" },
    }),
    {
      status: 401,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      },
    },
  );
}

/** Remote MCP (Streamable HTTP, stateless JSON response mode) */
export async function POST(req: Request) {
  const grant = authGrant(req);
  if (!grant) return unauthorized(req);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  // Streamable HTTP spec: one message per request; handle arrays leniently (process each, return array)
  const messages = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const msg of messages) {
    const res = await handleMcpMessage(msg, grant.home_id);
    if (res) responses.push(res);
  }

  if (responses.length === 0) {
    return new Response(null, { status: 202, headers: CORS_HEADERS });
  }
  return Response.json(Array.isArray(body) ? responses : responses[0], {
    headers: CORS_HEADERS,
  });
}

export function GET() {
  // Server-initiated streaming is not supported
  return new Response(null, { status: 405, headers: CORS_HEADERS });
}

export function DELETE() {
  return new Response(null, { status: 405, headers: CORS_HEADERS });
}

export function OPTIONS() {
  return corsPreflight();
}
