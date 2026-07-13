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

import { useEffect, useRef } from "react";
import {
  DOMD,
  DOMDProvider,
  useEditorStoreApi,
  type ImageLoader,
} from "@do-md/core-react";
import { isExternalSrc, resolveAssetRef } from "@/lib/client/asset-ref";
import { isDesktop } from "@/lib/client/desktop";
import { fetchAssetUrl, SERVE_BASE } from "@/lib/client/rpc";

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
