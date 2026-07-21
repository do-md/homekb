import { describe, expect, it } from "vitest";
import { DEFAULT_RELAY_URL } from "./connection";
import {
  allServices,
  builtinServices,
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

describe("builtinServices", () => {
  it("falls back to the official default relay when NEXT_PUBLIC_BUILTIN_SERVICES is unset", () => {
    const builtins = builtinServices();
    expect(builtins).toHaveLength(1);
    expect(builtins[0].url).toBe(DEFAULT_RELAY_URL);
    expect(builtins[0].builtin).toBe(true);
  });
});

describe("allServices", () => {
  it("includes the built-in default and dedupes user entries by URL", () => {
    const merged = allServices([
      { url: "https://x.example" },
      { url: "https://x.example", thisMachine: true },
    ]);
    // Built-in default relay + the single deduped user entry.
    expect(merged).toHaveLength(2);
    expect(merged.some((e) => e.url === DEFAULT_RELAY_URL && e.builtin)).toBe(true);
    const x = merged.find((e) => e.url === "https://x.example");
    expect(x?.thisMachine).toBe(true);
  });

  it("merges a user entry's flags onto a matching built-in without duplicating it", () => {
    const merged = allServices([{ url: DEFAULT_RELAY_URL, thisMachine: true }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].builtin).toBe(true);
    expect(merged[0].thisMachine).toBe(true);
  });
});
