import { nanoid } from "nanoid";
import { relayDb } from "@/lib/relay/db";
import { CORS_HEADERS, corsPreflight } from "@/lib/relay/origin";

export const runtime = "nodejs";

/** RFC 7591 动态客户端注册（公开客户端，无 secret） */
export async function POST(req: Request) {
  let body: {
    redirect_uris?: unknown;
    client_name?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: "invalid_client_metadata" },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === "string").slice(0, 10)
    : [];
  if (redirectUris.length === 0) {
    return Response.json(
      { error: "invalid_redirect_uri", error_description: "redirect_uris required" },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  const clientId = "oc_" + nanoid(16);
  const name = typeof body.client_name === "string" ? body.client_name.slice(0, 128) : "";
  relayDb()
    .prepare(
      "INSERT INTO oauth_clients (client_id, redirect_uris, name, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(clientId, JSON.stringify(redirectUris), name, Date.now());

  return Response.json(
    {
      client_id: clientId,
      client_name: name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    },
    { status: 201, headers: CORS_HEADERS },
  );
}

export function OPTIONS() {
  return corsPreflight();
}
