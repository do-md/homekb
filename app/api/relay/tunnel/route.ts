import { authHome, jsonError } from "@/lib/relay/auth";
import { hub } from "@/lib/relay/hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PING_INTERVAL_MS = 25_000;

/** Home device tunnel downstream: long-lived SSE connection, pushes RPC instructions */
export async function GET(req: Request) {
  const home = authHome(req);
  if (!home) return jsonError(401, "unauthorized");

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event: string, data: string) => {
        if (closed) throw new Error("stream closed");
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        try {
          controller.close();
        } catch {}
      };
      const conn = hub().register(home.id, send, cleanup);
      const ping = setInterval(() => {
        try {
          send("ping", String(Date.now()));
        } catch {
          cleanup();
          hub().unregister(home.id, conn);
        }
      }, PING_INTERVAL_MS);

      req.signal.addEventListener("abort", () => {
        hub().unregister(home.id, conn);
        cleanup();
      });

      send("hello", JSON.stringify({ homeId: home.id, name: home.name }));
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
