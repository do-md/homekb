/** Worker bindings (declared in wrangler.jsonc). */
export interface Env {
  /** Pairing relationships + token hashes only — zero knowledge-base data. */
  DB: D1Database;
  /** One Durable Object per home (idFromName(home_id)) — the tunnel hub. */
  TUNNEL_DO: DurableObjectNamespace;
}
