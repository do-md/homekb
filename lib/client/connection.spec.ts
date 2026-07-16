import { describe, expect, it } from "vitest";
import { parsePairingLink } from "./connection";

describe("parsePairingLink", () => {
  it("parses a pairing link and uppercases the code", () => {
    expect(
      parsePairingLink("https://app.homekb.app/?relay=https://relay.homekb.app&code=a7km2xq9"),
    ).toEqual({ relayUrl: "https://relay.homekb.app", code: "A7KM2XQ9" });
  });

  it("accepts any web origin — only the params matter", () => {
    expect(
      parsePairingLink("http://192.168.1.20:3000/?relay=http://192.168.1.20:8787&code=X1Y2Z3W4"),
    ).toEqual({ relayUrl: "http://192.168.1.20:8787", code: "X1Y2Z3W4" });
  });

  it("strips a trailing slash from the service URL", () => {
    const link = parsePairingLink("https://app.homekb.app/?relay=https://r.example/&code=A");
    expect(link).toMatchObject({ relayUrl: "https://r.example" });
  });

  it("rejects links missing a code or a service URL", () => {
    expect(parsePairingLink("https://app.homekb.app/?relay=https://relay.homekb.app")).toBeNull();
    expect(parsePairingLink("https://app.homekb.app/?code=ABCD")).toBeNull();
  });

  it("rejects a non-URL service address", () => {
    expect(parsePairingLink("https://app.homekb.app/?relay=not-a-url&code=ABCD")).toBeNull();
  });

  it("rejects non-http(s) and malformed payloads", () => {
    expect(parsePairingLink("ftp://x/?relay=http://h&code=A")).toBeNull();
    expect(parsePairingLink("just some text")).toBeNull();
  });
});
