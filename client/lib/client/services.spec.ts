import { describe, expect, it } from "vitest";
import {
  allServices,
  isAllowedServiceUrl,
  pickAutoService,
  type ServiceEntry,
  type ServiceProbe,
} from "./services";

const probes = (m: Record<string, Partial<ServiceProbe>>): Record<string, ServiceProbe> =>
  Object.fromEntries(
    Object.entries(m).map(([url, p]) => [url, { ok: p.ok ?? false, ms: p.ms ?? null }]),
  );

describe("pickAutoService", () => {
  const a: ServiceEntry = { url: "https://a.example" };
  const b: ServiceEntry = { url: "https://b.example" };
  const local: ServiceEntry = { url: "https://home.example", thisMachine: true };

  it("prefers a reachable this-machine entry over lower-latency remotes", () => {
    const picked = pickAutoService(
      [a, b, local],
      probes({
        "https://a.example": { ok: true, ms: 5 },
        "https://b.example": { ok: true, ms: 8 },
        "https://home.example": { ok: true, ms: 90 },
      }),
    );
    expect(picked?.url).toBe("https://home.example");
  });

  it("skips an unreachable this-machine entry and picks the nearest remote", () => {
    const picked = pickAutoService(
      [a, b, local],
      probes({
        "https://a.example": { ok: true, ms: 42 },
        "https://b.example": { ok: true, ms: 17 },
        "https://home.example": { ok: false },
      }),
    );
    expect(picked?.url).toBe("https://b.example");
  });

  it("returns null when nothing is reachable", () => {
    expect(
      pickAutoService([a, b], probes({ "https://a.example": {}, "https://b.example": {} })),
    ).toBeNull();
  });

  it("ignores entries that were never probed", () => {
    const picked = pickAutoService([a, b], probes({ "https://b.example": { ok: true, ms: 30 } }));
    expect(picked?.url).toBe("https://b.example");
  });
});

describe("isAllowedServiceUrl", () => {
  it("accepts public https URLs", () => {
    expect(isAllowedServiceUrl("https://relay.example.com")).toBe(true);
    expect(isAllowedServiceUrl("https://home.example.com:8443")).toBe(true);
  });

  it("rejects plain-http, localhost, and garbage — https only, no exceptions", () => {
    expect(isAllowedServiceUrl("http://localhost:8787")).toBe(false);
    expect(isAllowedServiceUrl("https://localhost:8787")).toBe(true); // scheme is what matters
    expect(isAllowedServiceUrl("http://192.168.1.20:8787")).toBe(false);
    expect(isAllowedServiceUrl("not a url")).toBe(false);
  });
});

describe("allServices", () => {
  it("dedupes user entries against built-ins by URL (no built-ins configured in tests)", () => {
    const merged = allServices([
      { url: "https://x.example" },
      { url: "https://x.example", thisMachine: true },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].thisMachine).toBe(true);
  });
});
