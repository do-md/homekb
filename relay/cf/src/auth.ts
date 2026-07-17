import type { Env } from "./env";
import { bearerToken, sha256hex } from "./util";

/**
 * Bearer-token authentication against D1 — async port of ../node/src/lib/relay/auth.ts.
 * Same row shapes as the Node target so the route code ports 1:1.
 */

export interface HomeRow {
  id: string;
  name: string;
}

/** Authenticate a home device (homeSecret); on success also updates last_seen_at. */
export async function authHome(req: Request, env: Env): Promise<HomeRow | null> {
  const token = bearerToken(req);
  if (!token || !token.startsWith("hks_")) return null;
  const row = await env.DB.prepare("SELECT id, name FROM homes WHERE secret_hash = ?")
    .bind(await sha256hex(token))
    .first<HomeRow>();
  if (!row) return null;
  await env.DB.prepare("UPDATE homes SET last_seen_at = ? WHERE id = ?")
    .bind(Date.now(), row.id)
    .run();
  return row;
}

export interface GrantRow {
  id: string;
  home_id: string;
  label: string;
}

/** Authenticate a remote client (clientToken / OAuth access token — same thing). */
export async function authGrant(req: Request, env: Env): Promise<GrantRow | null> {
  const token = bearerToken(req);
  if (!token || !token.startsWith("hkt_")) return null;
  const row = await env.DB.prepare("SELECT id, home_id, label FROM grants WHERE token_hash = ?")
    .bind(await sha256hex(token))
    .first<GrantRow>();
  if (!row) return null;
  await env.DB.prepare("UPDATE grants SET last_used_at = ? WHERE id = ?")
    .bind(Date.now(), row.id)
    .run();
  return row;
}
