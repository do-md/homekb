// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { RpcHubError, TunnelHub } from "./hub";

function connect(hub: TunnelHub, homeId = "hm_test") {
  const sent: { event: string; data: string }[] = [];
  const close = vi.fn();
  const conn = hub.register(
    homeId,
    (event, data) => sent.push({ event, data }),
    close,
  );
  return { conn, sent, close };
}

describe("TunnelHub", () => {
  it("call rejects with home_offline when home device is not connected", async () => {
    const hub = new TunnelHub();
    await expect(hub.call("hm_nope", "kb.status", {})).rejects.toMatchObject({
      code: "home_offline",
    });
  });

  it("full round-trip: call sends rpc event, resolveResult resolves the promise", async () => {
    const hub = new TunnelHub();
    const { sent } = connect(hub);
    const p = hub.call("hm_test", "kb.query", { query: "x" });
    expect(sent).toHaveLength(1);
    const msg = JSON.parse(sent[0].data);
    expect(msg.method).toBe("kb.query");
    hub.resolveResult("hm_test", msg.id, true, { hello: 1 });
    await expect(p).resolves.toEqual({ hello: 1 });
  });

  it("rejects with rpc_error and passes through detail when home returns ok:false", async () => {
    const hub = new TunnelHub();
    const { sent } = connect(hub);
    const p = hub.call("hm_test", "kb.read", { path: "../etc" });
    const msg = JSON.parse(sent[0].data);
    hub.resolveResult("hm_test", msg.id, false, undefined, {
      code: "bad_path",
      message: "path traversal",
    });
    await expect(p).rejects.toMatchObject({
      code: "rpc_error",
      detail: { code: "bad_path" },
    });
  });

  it("rejects after timeout and silently discards late results", async () => {
    vi.useFakeTimers();
    const hub = new TunnelHub();
    const { sent } = connect(hub);
    const p = hub.call("hm_test", "kb.status", {}, 100);
    const rejection = expect(p).rejects.toMatchObject({ code: "timeout" });
    vi.advanceTimersByTime(150);
    await rejection;
    const msg = JSON.parse(sent[0].data);
    // late result must not throw
    hub.resolveResult("hm_test", msg.id, true, {});
    vi.useRealTimers();
  });

  it("on reconnect, all pending requests of old connection are rejected and old connection is closed", async () => {
    const hub = new TunnelHub();
    const first = connect(hub);
    const p = hub.call("hm_test", "kb.status", {});
    const rejection = expect(p).rejects.toMatchObject({ code: "tunnel_closed" });
    connect(hub); // reconnect with same homeId
    await rejection;
    expect(first.close).toHaveBeenCalled();
    expect(hub.online("hm_test")).toBe(true);
  });

  it("stale connection abort does not evict new connection (unregister identity guard)", () => {
    const hub = new TunnelHub();
    const first = connect(hub);
    connect(hub); // new connection takes over
    hub.unregister("hm_test", first.conn); // abort callback from old connection
    expect(hub.online("hm_test")).toBe(true);
  });

  it("call rejects immediately when send throws", async () => {
    const hub = new TunnelHub();
    hub.register(
      "hm_test",
      () => {
        throw new Error("stream closed");
      },
      () => {},
    );
    await expect(hub.call("hm_test", "kb.status", {})).rejects.toBeInstanceOf(
      RpcHubError,
    );
  });

  it("asset event forwards image variant query/accept and omits them when absent", () => {
    const hub = new TunnelHub();
    const { sent } = connect(hub);

    void hub.requestAsset("hm_test", "images/a.png", {
      query: "w=800&f=webp",
      accept: "image/webp,*/*",
    });
    expect(sent[0].event).toBe("asset");
    const withVariant = JSON.parse(sent[0].data);
    expect(withVariant.path).toBe("images/a.png");
    expect(withVariant.query).toBe("w=800&f=webp");
    expect(withVariant.accept).toBe("image/webp,*/*");

    void hub.requestAsset("hm_test", "images/b.png");
    const bare = JSON.parse(sent[1].data);
    expect(bare.path).toBe("images/b.png");
    expect("query" in bare).toBe(false);
    expect("accept" in bare).toBe(false);

    // Share context still rides alongside the variant fields.
    void hub.requestAsset("hm_test", "images/c.png", {
      share: { shareId: "sh_x" },
      query: "raw=1",
    });
    const shared = JSON.parse(sent[2].data);
    expect(shared.share).toEqual({ shareId: "sh_x" });
    expect(shared.query).toBe("raw=1");
  });
});
