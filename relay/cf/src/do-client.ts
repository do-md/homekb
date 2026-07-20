import type { Env } from "./env";
import { DO_STATUS_DELIVERY_ERROR, DO_STATUS_HUB_ERROR, type RpcError } from "./tunnel-do";

/**
 * Worker-side client for the per-home tunnel DO. Presentation (HTTP statuses toward
 * remote clients) lives in the routes; this module only translates the internal
 * wrapper protocol back into structured results.
 */

export type HubCode = "home_offline" | "timeout" | "tunnel_closed" | "rpc_error";

export class HubClientError extends Error {
  constructor(
    public code: HubCode,
    message: string,
    public detail?: RpcError | null,
  ) {
    super(message);
  }
}

/** Map a hub error to the client-facing HTTP status (same table as the Node routes). */
export function hubErrorStatus(code: HubCode): number {
  return code === "home_offline" ? 502 : code === "timeout" ? 504 : 500;
}

export function tunnelStub(env: Env, homeId: string): DurableObjectStub {
  return env.TUNNEL_DO.get(env.TUNNEL_DO.idFromName(homeId));
}

async function throwHubError(res: Response): Promise<never> {
  const body = (await res.json()) as { code: HubCode; message: string; detail?: RpcError | null };
  throw new HubClientError(body.code, body.message, body.detail);
}

/** Plain RPC through the tunnel. Throws HubClientError on hub-level failures. */
export async function callHome(
  env: Env,
  homeId: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  const res = await tunnelStub(env, homeId).fetch("https://do/rpc", {
    method: "POST",
    body: JSON.stringify({ method, params }),
  });
  if (res.status === DO_STATUS_HUB_ERROR) await throwHubError(res);
  const body = (await res.json()) as { ok: boolean; result?: unknown };
  return body.result;
}

export interface StreamDelivery {
  /** Delivery-level error from the home (e.g. asset not_found). */
  error?: string;
  contentType?: string;
  contentLength?: string;
  body: ReadableStream<Uint8Array> | null;
}

async function requestStream(env: Env, homeId: string, path: string, payload: unknown): Promise<StreamDelivery> {
  const res = await tunnelStub(env, homeId).fetch(`https://do${path}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (res.status === DO_STATUS_HUB_ERROR) await throwHubError(res);
  if (res.status === DO_STATUS_DELIVERY_ERROR) {
    const body = (await res.json()) as { error: string };
    return { error: body.error, body: null };
  }
  return {
    contentType: res.headers.get("content-type") ?? undefined,
    contentLength: res.headers.get("content-length") ?? undefined,
    body: res.body,
  };
}

/** Share context attached to a share-scoped asset request (validated by the home). */
export interface ShareContext {
  shareId: string;
  password?: string;
}

/** Binary asset channel (docs/ARCHITECTURE.md): streamed, never buffered.
 *  `query`/`accept` forward the client's image-variant request ("Image variant
 *  service"); older engines ignore both. */
export function requestAsset(
  env: Env,
  homeId: string,
  path: string,
  opts: { share?: ShareContext; query?: string; accept?: string } = {},
): Promise<StreamDelivery> {
  return requestStream(env, homeId, "/asset-request", {
    path,
    ...(opts.query ? { query: opts.query } : {}),
    ...(opts.accept ? { accept: opts.accept } : {}),
    ...(opts.share ? { share: opts.share } : {}),
  });
}

/** Streaming answer channel: the home's SSE frames, piped verbatim. */
export function requestAskStream(env: Env, homeId: string, params: unknown): Promise<StreamDelivery> {
  return requestStream(env, homeId, "/ask-request", { params });
}

/**
 * Binary asset channel, upload direction: stream the client's raw bytes to the
 * DO, which parks them until the home claims the body and reports the final
 * asset path. Resolves with the home's result (`{path}`); throws HubClientError
 * on hub-level failures (offline / timeout / engine rpc_error).
 */
export async function requestAssetUpload(
  env: Env,
  homeId: string,
  path: string,
  source: { contentType?: string; contentLength?: string; body: ReadableStream<Uint8Array> },
): Promise<unknown> {
  const headers = new Headers({ "x-upload-path": path });
  if (source.contentType) headers.set("Content-Type", source.contentType);
  if (source.contentLength) headers.set("Content-Length", source.contentLength);
  const res = await tunnelStub(env, homeId).fetch("https://do/upload-request", {
    method: "POST",
    headers,
    body: source.body,
  });
  if (res.status === DO_STATUS_HUB_ERROR) await throwHubError(res);
  const body = (await res.json()) as { ok: boolean; result?: unknown };
  return body.result;
}

/** Home-side claim of a pending upload body: passed through verbatim (200 stream | 404). */
export function claimUpload(env: Env, homeId: string, id: string): Promise<Response> {
  return tunnelStub(env, homeId).fetch(`https://do/upload-claim/${encodeURIComponent(id)}`);
}

/** The current DO instance's view of the home's tunnel. */
export async function homeConnInfo(
  env: Env,
  homeId: string,
): Promise<{ online: boolean; connId: string | null }> {
  const res = await tunnelStub(env, homeId).fetch("https://do/online");
  return (await res.json()) as { online: boolean; connId: string | null };
}

/** Whether the home's tunnel is currently connected. */
export async function homeOnline(env: Env, homeId: string): Promise<boolean> {
  return (await homeConnInfo(env, homeId)).online;
}
