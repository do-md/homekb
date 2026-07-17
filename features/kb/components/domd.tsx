"use client";

/**
 * DOMD integration: one read-only Markdown view + one WYSIWYG editor, both themed
 * through the .hk-domd token bridge (globals.css).
 *
 * Image srcs follow docs/ARCHITECTURE.md "Image references in notes": relative refs
 * that resolve into assets/ load through the asset service — desktop mode returns a
 * plain loopback serve URL (browser-cached); relay/direct modes fetch with the
 * Authorization header and return blob URLs (tokens never appear in URLs). External
 * http(s)/data: srcs pass through untouched; anything unresolvable rejects and DOMD
 * renders its broken-image state — never a stray network request.
 */

import { useEffect, useLayoutEffect, useRef } from "react";
import {
  DOMD,
  DOMDProvider,
  type EditorStore,
  useEditorStoreApi,
  type ImageLoader,
} from "@do-md/core-react";
import { assetRefFromNote, isExternalSrc, resolveAssetRef } from "@/lib/client/asset-ref";
import { isDesktop } from "@/lib/client/desktop";
import { fetchAssetUrl, SERVE_BASE, uploadAsset } from "@/lib/client/rpc";
import { useKbStoreApi } from "../store/kb-store";

/** Build an ImageLoader bound to the note the markdown came from. */
export function makeImageLoader(notePath: string): ImageLoader {
  return async (src: string) => {
    if (isExternalSrc(src)) return src;
    const assetPath = resolveAssetRef(notePath, src);
    if (!assetPath) throw new Error("not an asset reference");
    if (isDesktop()) {
      // Loopback serve needs no auth; a plain URL lets the browser cache it.
      const encoded = assetPath.split("/").map(encodeURIComponent).join("/");
      return `${SERVE_BASE}/assets/${encoded}`;
    }
    // relay/direct: authenticated fetch → blob URL (lives for the page session).
    return fetchAssetUrl(assetPath);
  };
}

/**
 * Read-only Markdown rendering.
 * DOMDProvider parses initMd once at mount — callers must remount on content change
 * (key by note path + a version counter bumped on load/save).
 */
export function KbMarkdown({
  content,
  notePath,
  className = "",
}: {
  content: string;
  notePath: string;
  className?: string;
}) {
  return (
    <div className={`hk-domd ${className}`}>
      <DOMDProvider editable={false} initMd={content} imageLoader={makeImageLoader(notePath)}>
        <DOMD />
      </DOMDProvider>
    </div>
  );
}

/** Hands this read-only DOMD editor to the KB store, which feeds it answer deltas via
 *  insertText (docs/ARCHITECTURE.md "Streaming answer channel"). useLayoutEffect so the
 *  editor is attached before the store's first flush frame runs. */
function StreamingBridge() {
  const editor = useEditorStoreApi() as unknown as EditorStore;
  const kb = useKbStoreApi();
  useLayoutEffect(() => {
    kb.attachLiveEditor(editor);
    return () => kb.detachLiveEditor(editor);
  }, [editor, kb]);
  return null;
}

/**
 * Live streaming answer body (design 3b): a persistent read-only DOMD seeded empty
 * (`initMd=""`). The KB store feeds it token chunks through insertText as they arrive —
 * real Markdown renders while it writes, no client-side typewriter, no per-token resetMD.
 * Remounts per answer (the parent gates it on phase), starting from an empty editor.
 */
export function KbStreamingAnswer({ className = "" }: { className?: string }) {
  return (
    <div className={`hk-domd ${className}`}>
      <DOMDProvider editable={false} initMd="" imageLoader={makeImageLoader("")}>
        <StreamingBridge />
        <DOMD />
      </DOMDProvider>
    </div>
  );
}

/** Imperative handle the editor exposes to its parent (serialize on demand). */
export interface KbEditorHandle {
  getMarkdown(): string;
}

function EditorBridge({
  handleRef,
}: {
  handleRef: React.MutableRefObject<KbEditorHandle | null>;
}) {
  const store = useEditorStoreApi();
  useEffect(() => {
    handleRef.current = {
      getMarkdown: () => {
        try {
          return store.toMarkdown();
        } catch {
          return "";
        }
      },
    };
    // Deliberately NOT nulled on cleanup: unmount cleanups run child-first, and the
    // compose view reads the handle in ITS cleanup to auto-stash unsaved drafts.
  }, [store, handleRef]);
  return null;
}

/** Map a pasted blob's MIME type to a file extension for the suggested name. */
const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/heic": "heic",
};

/**
 * Suggested upload name (the home owns the FINAL name — sanitizing + collision
 * suffixes). Real file names pass through; clipboard pastes arrive as a generic
 * "image.png", which would pile up as image-2/-3/… — stamp those instead.
 */
function suggestUploadName(file: File): string {
  const generic = !file.name || /^image\.\w+$/i.test(file.name);
  if (!generic) return file.name.replace(/[/\\]/g, "-");
  const ext = IMAGE_EXT[file.type] ?? "png";
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `pasted-${stamp}.${ext}`;
}

/**
 * Editor image upload (docs/ARCHITECTURE.md "Editor image upload"): capture-phase
 * paste/drop listeners on the editor container pre-empt DOMD's own text handlers
 * when the payload is image files. Each image is uploaded through the asset
 * service (shared `assets/images/`, home-owned naming), then inserted as a
 * standard relative Markdown reference resolved from this note's location —
 * the imageLoader renders it back through the same asset service.
 * Requires the home to be reachable; failures surface as a store notice.
 */
function ImagePasteDropBridge({
  notePath,
  containerRef,
}: {
  notePath: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const store = useEditorStoreApi() as unknown as EditorStore;
  const kb = useKbStoreApi();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const insertSequential = async (files: File[]) => {
      for (const file of files) {
        try {
          const assetPath = await uploadAsset(`images/${suggestUploadName(file)}`, file);
          store.insertImage(assetRefFromNote(notePath, assetPath), file.name || "image");
        } catch (e) {
          kb.notify(e instanceof Error ? e.message : "Image upload failed");
          break; // one notice, not one per file, when the home is unreachable
        }
      }
    };

    const imageFiles = (files: FileList | undefined | null): File[] =>
      Array.from(files ?? []).filter((f) => f.type.startsWith("image/"));

    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
        .map((i) => i.getAsFile())
        .filter((f): f is File => !!f);
      if (!files.length) return; // plain text → DOMD's own paste handler
      e.preventDefault();
      e.stopPropagation();
      void insertSequential(files);
    };
    const onDragOver = (e: DragEvent) => {
      // preventDefault is required to make the element a drop target for files.
      if (Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === "file")) {
        e.preventDefault();
      }
    };
    const onDrop = (e: DragEvent) => {
      const files = imageFiles(e.dataTransfer?.files);
      if (!files.length) return; // text drops → DOMD's own drop handler
      e.preventDefault();
      e.stopPropagation();
      void insertSequential(files);
    };

    el.addEventListener("paste", onPaste, true);
    el.addEventListener("dragover", onDragOver, true);
    el.addEventListener("drop", onDrop, true);
    return () => {
      el.removeEventListener("paste", onPaste, true);
      el.removeEventListener("dragover", onDragOver, true);
      el.removeEventListener("drop", onDrop, true);
    };
  }, [store, kb, notePath, containerRef]);

  return null;
}

/**
 * WYSIWYG Markdown editor (pure in-place rendering, no raw-syntax mode).
 * Uncontrolled: content lives in the DOMD store; the parent pulls markdown out
 * through `handleRef.current.getMarkdown()` on save. Remount (key) to reseed.
 */
export function KbEditor({
  seed,
  placeholder,
  notePath = "",
  handleRef,
  autoFocus = false,
  className = "",
}: {
  seed: string;
  placeholder?: string;
  notePath?: string;
  handleRef: React.MutableRefObject<KbEditorHandle | null>;
  autoFocus?: boolean;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    // Focus the contenteditable root once mounted.
    const el = containerRef.current?.querySelector<HTMLElement>("[contenteditable]");
    el?.focus();
  }, [autoFocus]);

  return (
    <div ref={containerRef} className={`hk-domd ${className}`}>
      <DOMDProvider
        editable
        initMd={seed}
        placeholder={placeholder}
        imageLoader={makeImageLoader(notePath)}
      >
        <EditorBridge handleRef={handleRef} />
        <ImagePasteDropBridge notePath={notePath} containerRef={containerRef} />
        <DOMD />
      </DOMDProvider>
    </div>
  );
}

/** First non-empty line, stripped of heading markers — becomes the note title. */
export function titleFromMarkdown(md: string): string {
  for (const line of md.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    return t.replace(/^#{1,6}\s+/, "").replace(/[*_`]/g, "").trim();
  }
  return "";
}
