import { relayDb } from "./lib/relay/db";

/**
 * OAuth authorization page — enter pairing code (no account system).
 * Served by the relay itself (the Web UI is a separate pure frontend).
 * Follows the system light/dark theme via prefers-color-scheme only.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PAGE_CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f4f4f5; color: #18181b; padding: 16px;
  }
  .card { background: #fff; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,.08); width: 100%; max-width: 380px; padding: 28px; }
  h1 { font-size: 1.15rem; margin: 0 0 12px; }
  p { font-size: .85rem; line-height: 1.5; }
  .muted { opacity: .7; }
  .tiny { font-size: .72rem; opacity: .5; margin-top: 14px; }
  .error { color: #dc2626; font-size: .85rem; }
  code { font-size: .75rem; background: rgba(0,0,0,.06); padding: 1px 5px; border-radius: 4px; }
  input[name=pair_code] {
    width: 100%; text-align: center; font-family: ui-monospace, monospace; font-size: 1.15rem;
    letter-spacing: .35em; text-transform: uppercase; padding: 10px 12px; margin: 14px 0 10px;
    border: 1px solid #d4d4d8; border-radius: 10px; background: transparent; color: inherit;
  }
  button {
    width: 100%; padding: 10px 12px; border: 0; border-radius: 10px; font-size: .9rem;
    background: #18181b; color: #fff; cursor: pointer;
  }
  button:hover { opacity: .88; }
  @media (prefers-color-scheme: dark) {
    body { background: #18181b; color: #f4f4f5; }
    .card { background: #27272a; box-shadow: 0 4px 24px rgba(0,0,0,.4); }
    code { background: rgba(255,255,255,.1); }
    input[name=pair_code] { border-color: #3f3f46; }
    button { background: #f4f4f5; color: #18181b; }
    .error { color: #f87171; }
  }
`;

function shell(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HomeKB Authorization</title>
<style>${PAGE_CSS}</style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
}

export function renderAuthorizePage(searchParams: URLSearchParams): Response {
  const get = (k: string) => searchParams.get(k) ?? "";
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

  if (invalid) {
    return html(shell(`<h1>HomeKB Authorization</h1><p class="error">${esc(invalid)}</p>`), 400);
  }

  const hidden = [
    "client_id",
    "redirect_uri",
    "state",
    "code_challenge",
    "code_challenge_method",
    "scope",
    "response_type",
  ]
    .map((k) => `<input type="hidden" name="${k}" value="${esc(get(k))}">`)
    .join("\n");

  const body = `
<h1>HomeKB Authorization</h1>
<p class="muted"><b>${esc(client!.name || "An MCP client")}</b> is requesting access to the knowledge base on your home device. Enter the pairing code (run <code>homekb pair</code> on your home device to get one).</p>
${error === "bad_code" ? `<p class="error">Pairing code is invalid or expired. Please generate a new one.</p>` : ""}
<form method="POST" action="/api/oauth/authorize">
${hidden}
<input name="pair_code" required autofocus placeholder="e.g. A7KM2XQ9" autocomplete="one-time-code" maxlength="8">
<button type="submit">Authorize Access</button>
</form>
<p class="tiny">Your data always stays on your own computer. This server only relays requests and never stores any knowledge base content.</p>`;

  return html(shell(body));
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
