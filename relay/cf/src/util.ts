/**
 * Crypto + id utilities. Web-Crypto ports of ../node/src/lib/relay/auth.ts helpers —
 * token/pair-code formats are part of the protocol contract (docs/ARCHITECTURE.md
 * "Token formats") and must stay identical to the Node target.
 */

/** sha256 hex digest (Web Crypto — async, unlike the Node version). */
export async function sha256hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Generate a token: prefix + 48 hex characters (24 random bytes). */
export function randomToken(prefix: "hks_" | "hkt_"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return prefix + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Pairing code: 8 characters, ambiguous characters excluded (no I/O/0/1). */
const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function randomPairCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = "";
  for (let i = 0; i < 8; i++) out += PAIR_ALPHABET[bytes[i] % PAIR_ALPHABET.length];
  return out;
}

/** nanoid-compatible random id (same alphabet: A-Za-z0-9_-). */
const ID_ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
export function randomId(size: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let out = "";
  for (let i = 0; i < size; i++) out += ID_ALPHABET[bytes[i] & 63];
  return out;
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

export function b64url(buf: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function jsonError(status: number, error: string): Response {
  return Response.json({ ok: false, error }, { status });
}
