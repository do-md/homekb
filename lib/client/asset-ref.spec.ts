import { describe, expect, it } from "vitest";
import { resolveAssetRef } from "./asset-ref";

describe("resolveAssetRef", () => {
  it("resolves the canonical form from a top-level note", () => {
    expect(resolveAssetRef("foo.md", "../assets/images/bar.png")).toBe("images/bar.png");
  });

  it("resolves from a nested note", () => {
    expect(resolveAssetRef("sub/foo.md", "../../assets/images/bar.png")).toBe("images/bar.png");
    expect(resolveAssetRef("a/b/foo.md", "../../../assets/attachments/x.pdf")).toBe(
      "attachments/x.pdf",
    );
  });

  it("normalizes ./ segments and empty segments", () => {
    expect(resolveAssetRef("foo.md", ".././assets//images/./bar.png")).toBe("images/bar.png");
  });

  it("decodes percent-encoding and strips query/fragment", () => {
    expect(resolveAssetRef("foo.md", "../assets/images/my%20pic.png")).toBe("images/my pic.png");
    expect(resolveAssetRef("foo.md", "../assets/images/bar.png#center")).toBe("images/bar.png");
    expect(resolveAssetRef("foo.md", "../assets/images/bar.png?v=2")).toBe("images/bar.png");
  });

  it("passes external URLs through as non-assets", () => {
    expect(resolveAssetRef("foo.md", "https://example.com/x.png")).toBeNull();
    expect(resolveAssetRef("foo.md", "http://example.com/x.png")).toBeNull();
    expect(resolveAssetRef("foo.md", "data:image/png;base64,AAAA")).toBeNull();
    expect(resolveAssetRef("foo.md", "blob:http://localhost/xyz")).toBeNull();
  });

  it("rejects srcs that stay inside notes/", () => {
    expect(resolveAssetRef("foo.md", "./images/bar.png")).toBeNull();
    expect(resolveAssetRef("sub/foo.md", "../other.md")).toBeNull();
  });

  it("rejects escapes above the virtual data root", () => {
    expect(resolveAssetRef("foo.md", "../../assets/images/bar.png")).toBeNull();
    expect(resolveAssetRef("foo.md", "../../../etc/passwd")).toBeNull();
  });

  it("rejects a bare assets/ ref pointing at the assets root itself", () => {
    expect(resolveAssetRef("foo.md", "../assets")).toBeNull();
    expect(resolveAssetRef("foo.md", "../assets/")).toBeNull();
  });

  it("rejects absolute, backslash, NUL, and malformed srcs", () => {
    expect(resolveAssetRef("foo.md", "/assets/images/bar.png")).toBeNull();
    expect(resolveAssetRef("foo.md", "..\\assets\\images\\bar.png")).toBeNull();
    expect(resolveAssetRef("foo.md", "../assets/images/bar\0.png")).toBeNull();
    expect(resolveAssetRef("foo.md", "../assets/images/%")).toBeNull();
    expect(resolveAssetRef("foo.md", "")).toBeNull();
  });

  it("does not let .. inside the src escape back out of assets", () => {
    expect(resolveAssetRef("foo.md", "../assets/../notes/secret.md")).toBeNull();
  });
});
