"use client";

import dynamic from "next/dynamic";

/**
 * /s — public share viewer (docs/ARCHITECTURE.md "Note sharing" + "UI routes").
 * Reads `?id=<shareId>&r=<service url>`; the Web deployment rewrites the pretty
 * form `/s/<id>` onto this page (next.config rewrites, web build only).
 *
 * Deliberately OUTSIDE the (app) route group: no providers/gates, no connect
 * screen — an anonymous visitor needs no pairing. ssr:false because everything
 * (params, fetch, blob URLs) is client-side; the static-export build ships the
 * loading shell.
 */
const ShareViewer = dynamic(
  () => import("@/features/kb/components/share-viewer").then((m) => m.ShareViewer),
  {
    ssr: false,
    loading: () => (
      <main className="fixed inset-0 flex items-center justify-center">
        <span
          className="hk-spin inline-block h-5 w-5 rounded-full border-2 border-current border-t-transparent text-hk-coral-text"
          aria-label="Loading"
        />
      </main>
    ),
  },
);

export default function SharePage() {
  return <ShareViewer />;
}
