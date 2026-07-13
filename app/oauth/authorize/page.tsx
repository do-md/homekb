import { relayDb } from "@/lib/relay/db";

export const dynamic = "force-dynamic";

/**
 * OAuth authorization page — enter pairing code (no account system).
 * MCP clients (Claude mobile, etc.) redirect here; the user enters the pairing code
 * generated on their home device to complete authorization.
 */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const get = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const clientId = get("client_id");
  const redirectUri = get("redirect_uri");
  const error = get("error");

  const client = clientId
    ? (relayDb()
        .prepare("SELECT client_id, redirect_uris, name FROM oauth_clients WHERE client_id = ?")
        .get(clientId) as { client_id: string; redirect_uris: string; name: string } | undefined)
    : undefined;

  const redirectOk =
    !!client && (JSON.parse(client.redirect_uris) as string[]).includes(redirectUri);

  const invalid = !client
    ? "Unknown client (invalid client_id)"
    : !redirectOk
      ? "Redirect URI does not match registered information"
      : get("response_type") !== "code"
        ? "Unsupported response_type"
        : null;

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="card bg-base-200 w-full max-w-sm shadow-xl">
        <div className="card-body">
          <h1 className="card-title">HomeKB Authorization</h1>
          {invalid ? (
            <p className="text-error">{invalid}</p>
          ) : (
            <>
              <p className="text-sm opacity-70">
                <span className="font-semibold">{client!.name || "An MCP client"}</span>{" "}
                is requesting access to the knowledge base on your home device. Enter the pairing code (run{" "}
                <code className="text-xs">homekb pair</code> on your home device to get one).
              </p>
              {error === "bad_code" && (
                <p className="text-error text-sm">Pairing code is invalid or expired. Please generate a new one.</p>
              )}
              <form method="POST" action="/api/oauth/authorize" className="mt-2 flex flex-col gap-3">
                <input type="hidden" name="client_id" value={clientId} />
                <input type="hidden" name="redirect_uri" value={redirectUri} />
                <input type="hidden" name="state" value={get("state")} />
                <input type="hidden" name="code_challenge" value={get("code_challenge")} />
                <input type="hidden" name="code_challenge_method" value={get("code_challenge_method")} />
                <input type="hidden" name="scope" value={get("scope")} />
                <input type="hidden" name="response_type" value={get("response_type")} />
                <input
                  name="pair_code"
                  required
                  autoFocus
                  placeholder="Pairing code, e.g. A7KM2XQ9"
                  className="input input-bordered w-full text-center font-mono text-lg uppercase tracking-widest"
                  autoComplete="one-time-code"
                  maxLength={8}
                />
                <button type="submit" className="btn btn-primary w-full">
                  Authorize Access
                </button>
              </form>
              <p className="mt-2 text-xs opacity-50">
                Your data always stays on your own computer. This server only relays requests and never stores any knowledge base content.
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
