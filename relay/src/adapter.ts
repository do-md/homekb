import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

/**
 * Minimal node:http ↔ web (Request/Response) adapter.
 * Lets the relay reuse route handlers written against the web fetch API
 * (originally Next.js route handlers) without any framework.
 */

/** Reverse-proxy-aware base URL for building the web Request (x-forwarded-* first). */
export function requestBase(req: IncomingMessage): string {
  const proto = firstHeader(req, "x-forwarded-proto") ?? "http";
  const host = firstHeader(req, "x-forwarded-host") ?? req.headers.host ?? "localhost";
  return `${proto}://${host}`;
}

function firstHeader(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

export function toWebRequest(req: IncomingMessage): Request {
  const url = new URL(req.url ?? "/", requestBase(req));
  const headers = webHeaders(req);
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (hasBody) {
    init.body = Readable.toWeb(req) as unknown as BodyInit;
    init.duplex = "half"; // required by undici when the body is a stream
  }
  return new Request(url, init);
}

/**
 * Headers-only web Request for the NATIVE streaming routes (asset/ask/upload
 * channels), whose handlers consume `nodeReq` as a raw node stream. Those
 * routes must never go through `toWebRequest`: `Readable.toWeb` eagerly pulls
 * the socket into the web wrapper's internal queue, so any handler that holds
 * the raw body across an await (e.g. the upload channel waiting for the home
 * to claim it) finds the node stream already drained and pipes nothing.
 */
export function toWebRequestHeaders(req: IncomingMessage): Request {
  const url = new URL(req.url ?? "/", requestBase(req));
  // Method normalized to GET: the auth helpers only look at URL + headers,
  // and a body-less GET Request can be constructed for any incoming method.
  return new Request(url, { method: "GET", headers: webHeaders(req) });
}

function webHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const item of v) headers.append(k, item);
    else if (typeof v === "string") headers.set(k, v);
  }
  return headers;
}

export async function sendWebResponse(
  webRes: Response,
  res: ServerResponse,
  extraHeaders?: Record<string, string>,
): Promise<void> {
  const headers: Record<string, string> = {};
  webRes.headers.forEach((value, key) => {
    headers[key] = value;
  });
  Object.assign(headers, extraHeaders);
  res.writeHead(webRes.status, headers);
  if (webRes.body) {
    const reader = webRes.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}
