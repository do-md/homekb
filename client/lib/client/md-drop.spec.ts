import { describe, expect, it } from "vitest";
import {
  dragLooksImportable,
  importTitleFromFilename,
  isMarkdownFile,
} from "./md-drop";

describe("isMarkdownFile", () => {
  it("accepts .md and .markdown extensions case-insensitively", () => {
    expect(isMarkdownFile({ name: "note.md", type: "" })).toBe(true);
    expect(isMarkdownFile({ name: "NOTE.MD", type: "" })).toBe(true);
    expect(isMarkdownFile({ name: "essay.markdown", type: "" })).toBe(true);
  });

  it("accepts markdown MIME types even without the extension", () => {
    expect(isMarkdownFile({ name: "note", type: "text/markdown" })).toBe(true);
    expect(isMarkdownFile({ name: "note", type: "text/x-markdown" })).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isMarkdownFile({ name: "photo.png", type: "image/png" })).toBe(false);
    expect(isMarkdownFile({ name: "notes.txt", type: "text/plain" })).toBe(false);
    expect(isMarkdownFile({ name: "readme.md.bak", type: "" })).toBe(false);
  });
});

describe("importTitleFromFilename", () => {
  it("strips the extension and keeps the stem", () => {
    expect(importTitleFromFilename("meeting notes.md")).toBe("meeting notes");
    expect(importTitleFromFilename("Essay.MARKDOWN")).toBe("Essay");
  });

  it("drops any leading path segments", () => {
    expect(importTitleFromFilename("dir/sub/note.md")).toBe("note");
    expect(importTitleFromFilename("dir\\note.md")).toBe("note");
  });

  it("returns empty for degenerate names (caller falls back to engine titling)", () => {
    expect(importTitleFromFilename(".md")).toBe("");
    expect(importTitleFromFilename("  .md")).toBe("");
  });
});

describe("dragLooksImportable", () => {
  it("requires a Files drag", () => {
    expect(dragLooksImportable(null)).toBe(false);
    expect(dragLooksImportable({ types: ["text/plain"], items: [] })).toBe(false);
  });

  it("accepts a non-image file item", () => {
    expect(
      dragLooksImportable({
        types: ["Files"],
        items: [{ kind: "file", type: "" }],
      }),
    ).toBe(true);
    expect(
      dragLooksImportable({
        types: ["Files"],
        items: [{ kind: "file", type: "text/markdown" }],
      }),
    ).toBe(true);
  });

  it("rejects image-only drags (the editor's image bridge owns those)", () => {
    expect(
      dragLooksImportable({
        types: ["Files"],
        items: [{ kind: "file", type: "image/png" }],
      }),
    ).toBe(false);
  });

  it("stays permissive when items are hidden mid-drag", () => {
    expect(dragLooksImportable({ types: ["Files"], items: [] })).toBe(true);
    expect(dragLooksImportable({ types: ["Files"] })).toBe(true);
  });
});
