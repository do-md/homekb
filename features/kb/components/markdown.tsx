"use client";

/**
 * Markdown rendering for the Reader, including note images.
 *
 * Image srcs follow docs/ARCHITECTURE.md "Image references in notes":
 * relative refs that resolve into assets/ are fetched through the asset
 * service — desktop mode embeds plain serve URLs (loopback, browser-cached);
 * relay/direct modes fetch with the Authorization header and render blob
 * URLs (tokens never appear in URLs). External http(s)/data: srcs pass
 * through untouched; anything unresolvable renders a placeholder, never a
 * network request.
 */

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isExternalSrc, resolveAssetRef } from "@/lib/client/asset-ref";
import { isDesktop } from "@/lib/client/desktop";
import { fetchAssetUrl, SERVE_BASE } from "@/lib/client/rpc";

type ImgState =
  | { kind: "loading" }
  | { kind: "ready"; url: string }
  | { kind: "broken"; reason: string };

function AssetImage({
  notePath,
  src,
  alt,
}: {
  notePath: string;
  src?: string;
  alt?: string;
}) {
  const [state, setState] = useState<ImgState>({ kind: "loading" });

  useEffect(() => {
    if (!src) {
      setState({ kind: "broken", reason: "missing src" });
      return;
    }
    if (isExternalSrc(src)) {
      setState({ kind: "ready", url: src });
      return;
    }
    const assetPath = resolveAssetRef(notePath, src);
    if (!assetPath) {
      setState({ kind: "broken", reason: "not an asset reference" });
      return;
    }
    if (isDesktop()) {
      // Loopback serve needs no auth; a plain URL lets the browser cache it.
      const encoded = assetPath.split("/").map(encodeURIComponent).join("/");
      setState({ kind: "ready", url: `${SERVE_BASE}/assets/${encoded}` });
      return;
    }
    // relay/direct: authenticated fetch → blob URL, revoked on unmount/change.
    let cancelled = false;
    let blobUrl: string | null = null;
    setState({ kind: "loading" });
    fetchAssetUrl(assetPath)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        blobUrl = url;
        setState({ kind: "ready", url });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          const reason = e instanceof Error ? e.message : "failed to load";
          setState({ kind: "broken", reason });
        }
      });
    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [notePath, src]);

  if (state.kind === "loading") {
    return <span className="skeleton block h-40 w-full rounded-lg" />;
  }
  if (state.kind === "broken") {
    return (
      <span className="border-base-300 text-base-content/50 block rounded-lg border border-dashed px-3 py-4 text-center text-xs">
        Image unavailable{alt ? ` — ${alt}` : ""}
        <span className="mt-1 block font-mono opacity-60">
          {src ?? ""} ({state.reason})
        </span>
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- dynamic blob/loopback URLs, next/image inapplicable
    <img
      src={state.url}
      alt={alt ?? ""}
      loading="lazy"
      className="max-w-full rounded-lg"
      onError={() => setState({ kind: "broken", reason: "load error" })}
    />
  );
}

export function KbMarkdown({ content, notePath }: { content: string; notePath: string }) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ src, alt }) => (
            <AssetImage notePath={notePath} src={typeof src === "string" ? src : undefined} alt={alt} />
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
