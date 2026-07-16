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

/** Binary asset channel (docs/ARCHITECTURE.md): streamed, never buffered. */
export function requestAsset(env: Env, homeId: string, path: string): Promise<StreamDelivery> {
  return requestStream(env, homeId, "/asset-request", { path });
}

/** Streaming answer channel: the home's SSE frames, piped verbatim. */
export function requestAskStream(env: Env, homeId: string, params: unknown): Promise<StreamDelivery> {
  return requestStream(env, homeId, "/ask-request", { params });
}

/** Whether the home's tunnel is currently connected. */
export async function homeOnline(env: Env, homeId: string): Promise<boolean> {
  const res = await tunnelStub(env, homeId).fetch("https://do/online");
  const body = (await res.json()) as { online: boolean };
  return body.online;
}
