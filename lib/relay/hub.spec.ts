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
  it("家端未连接时 call 直接拒绝 home_offline", async () => {
    const hub = new TunnelHub();
    await expect(hub.call("hm_nope", "kb.status", {})).rejects.toMatchObject({
      code: "home_offline",
    });
  });

  it("完整往返：call 下发 rpc 事件，resolveResult 兑现", async () => {
    const hub = new TunnelHub();
    const { sent } = connect(hub);
    const p = hub.call("hm_test", "kb.query", { query: "x" });
    expect(sent).toHaveLength(1);
    const msg = JSON.parse(sent[0].data);
    expect(msg.method).toBe("kb.query");
    hub.resolveResult("hm_test", msg.id, true, { hello: 1 });
    await expect(p).resolves.toEqual({ hello: 1 });
  });

  it("家端返回 ok:false 时以 rpc_error 拒绝并透传 detail", async () => {
    const hub = new TunnelHub();
    const { sent } = connect(hub);
    const p = hub.call("hm_test", "kb.read", { path: "../etc" });
    const msg = JSON.parse(sent[0].data);
    hub.resolveResult("hm_test", msg.id, false, undefined, {
      code: "bad_path",
      message: "路径穿越",
    });
    await expect(p).rejects.toMatchObject({
      code: "rpc_error",
      detail: { code: "bad_path" },
    });
  });

  it("超时后拒绝，迟到的结果被静默丢弃", async () => {
    vi.useFakeTimers();
    const hub = new TunnelHub();
    const { sent } = connect(hub);
    const p = hub.call("hm_test", "kb.status", {}, 100);
    const rejection = expect(p).rejects.toMatchObject({ code: "timeout" });
    vi.advanceTimersByTime(150);
    await rejection;
    const msg = JSON.parse(sent[0].data);
    // 迟到结果不抛错
    hub.resolveResult("hm_test", msg.id, true, {});
    vi.useRealTimers();
  });

  it("重连时旧连接的 pending 全部拒绝，且旧连接被 close", async () => {
    const hub = new TunnelHub();
    const first = connect(hub);
    const p = hub.call("hm_test", "kb.status", {});
    const rejection = expect(p).rejects.toMatchObject({ code: "tunnel_closed" });
    connect(hub); // 同 homeId 重连
    await rejection;
    expect(first.close).toHaveBeenCalled();
    expect(hub.online("hm_test")).toBe(true);
  });

  it("旧连接 abort 不误杀新连接（unregister 身份守卫）", () => {
    const hub = new TunnelHub();
    const first = connect(hub);
    connect(hub); // 新连接顶替
    hub.unregister("hm_test", first.conn); // 旧连接的 abort 回调
    expect(hub.online("hm_test")).toBe(true);
  });

  it("send 抛错时 call 立即以 tunnel_closed 拒绝", async () => {
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
});
