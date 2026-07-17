"use client";

/**
 * Hash sub-routing for dynamic overlays (reader doc, resumed draft).
 *
 * Top-level tabs are real Next.js routes (/search, /new, /new/drafts, /status,
 * /remote, /settings). Dynamic segments deliberately live in the URL hash
 * (`/search#doc=<path>`, `/new#draft=<id>`) instead of dynamic path routes:
 * the app ships as a static export for the desktop shell (no SSR for dynamic
 * params), and a pushed hash entry gives the system back gesture something to
 * pop — back closes the overlay instead of leaving the app.
 */

import { useSyncExternalStore } from "react";

/** pushState doesn't fire `hashchange`; our own writes broadcast this instead. */
const HASH_EVENT = "hk-hash";

function subscribe(cb: () => void) {
  window.addEventListener("hashchange", cb);
  window.addEventListener("popstate", cb);
  window.addEventListener(HASH_EVENT, cb);
  return () => {
    window.removeEventListener("hashchange", cb);
    window.removeEventListener("popstate", cb);
    window.removeEventListener(HASH_EVENT, cb);
  };
}

export function getHashParam(key: string): string | null {
  if (typeof window === "undefined") return null;
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return null;
  return new URLSearchParams(raw).get(key);
}

/** Reactive read of a `#key=value` hash param (null when absent). */
export function useHashParam(key: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => getHashParam(key),
    () => null,
  );
}

/** Serialize a same-page overlay hash target (for pushHash / router.push). */
export function hashHref(key: string, value: string): string {
  return `#${key}=${encodeURIComponent(value)}`;
}

/**
 * Open an overlay on the current page: pushes a history entry so the system
 * back gesture closes it. The state marker lets closeHashOverlay know the
 * entry is ours (vs. a deep link where back would exit the app). Next.js keeps
 * its router tree in history.state — carry it over so back/forward restoration
 * across the pushed entry keeps working.
 */
export function pushHash(key: string, value: string) {
  window.history.pushState(
    { ...(window.history.state as object | null), hkOverlay: true },
    "",
    hashHref(key, value),
  );
  window.dispatchEvent(new Event(HASH_EVENT));
}

/**
 * Close the overlay: pop the entry we pushed (keeps history clean), or — on a
 * deep link / cross-page navigation where the entry isn't ours — strip the
 * hash in place (preserving the router's history state) so back still leaves
 * the page, not the overlay.
 */
export function closeHashOverlay() {
  if ((window.history.state as { hkOverlay?: boolean } | null)?.hkOverlay) {
    window.history.back(); // fires popstate → subscribers update
  } else {
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search,
    );
    window.dispatchEvent(new Event(HASH_EVENT));
  }
}
