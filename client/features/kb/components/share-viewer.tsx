"use client";

/**
 * Public share viewer (docs/ARCHITECTURE.md "Note sharing"): read-only render of a
 * shared note, fetched through the relay's public share endpoints. Lives OUTSIDE the
 * app shell — no pairing, no providers/gates; the only inputs are the URL params
 * (`?id=<shareId>&r=<service url>`).
 *
 * The note is served live from the author's home machine. Every policy decision
 * (password / expiry / revocation) is enforced there; this component just renders the
 * outcome, including the honest "library is offline" state.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { DOMD, DOMDProvider, type ImageLoader } from "@do-md/core-react";
import { isExternalSrc, resolveAssetRef } from "@/lib/client/asset-ref";
import { defaultRelayUrl, normalizeBaseUrl } from "@/lib/client/connection";
import { Spinner } from "./icons";

interface SharedNote {
  path: string;
  title: string;
  content: string;
  mtime: number;
}

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; note: SharedNote }
  | { kind: "password"; error?: string }
  | { kind: "gone"; error: "share_not_found" | "share_expired" }
  | { kind: "offline" }
  | { kind: "error"; message: string };

function readParams(): { shareId: string; relayUrl: string } {
  const params = new URLSearchParams(window.location.search);
  // Two link forms resolve here: `/s?id=<shareId>` (canonical page) and the pretty
  // `/s/<shareId>` (served via a server-side rewrite — the browser URL keeps the
  // path form, so the id must be read from the pathname, not the query).
  let shareId = params.get("id") ?? "";
  if (!shareId) {
    const m = window.location.pathname.match(/^\/s\/([0-9a-f]{32})\/?$/);
    if (m) shareId = m[1];
  }
  const relayUrl = normalizeBaseUrl(params.get("r") ?? "") || normalizeBaseUrl(defaultRelayUrl());
  return { shareId, relayUrl };
}

/** Share-scoped image loader: assets fetch through the public share asset endpoint. */
function makeShareImageLoader(
  relayUrl: string,
  shareId: string,
  password: string | null,
  notePath: string,
): ImageLoader {
  return async (src: string) => {
    if (isExternalSrc(src)) return src;
    const assetPath = resolveAssetRef(notePath, src);
    if (!assetPath) throw new Error("not an asset reference");
    const encoded = assetPath.split("/").map(encodeURIComponent).join("/");
    const res = await fetch(`${relayUrl}/api/relay/share/${shareId}/asset/${encoded}`, {
      headers: password ? { "X-Share-Password": password } : undefined,
    });
    if (!res.ok) throw new Error(`asset fetch failed: ${res.status}`);
    return URL.createObjectURL(await res.blob());
  };
}

export function ShareViewer() {
  const [{ shareId, relayUrl }] = useState(readParams);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [passwordInput, setPasswordInput] = useState("");
  /** The password that successfully unlocked the note (asset fetches reuse it). */
  const [unlockedPassword, setUnlockedPassword] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (password?: string) => {
      if (!shareId || !relayUrl) {
        setPhase({
          kind: "error",
          message: !shareId
            ? "This link is missing its share id."
            : "This link does not say which connection service to ask.",
        });
        return;
      }
      setBusy(true);
      try {
        const res = await fetch(`${relayUrl}/api/relay/share/${shareId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(password ? { password } : {}),
        });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          result?: SharedNote;
          error?: string;
          message?: string;
        };
        if (res.ok && body.ok && body.result) {
          setUnlockedPassword(password ?? null);
          setPhase({ kind: "ready", note: body.result });
          return;
        }
        switch (body.error) {
          case "share_password_required":
            setPhase({ kind: "password" });
            return;
          case "share_password_wrong":
            setPhase({ kind: "password", error: "Wrong password — try again." });
            return;
          case "share_not_found":
          case "share_expired":
            setPhase({ kind: "gone", error: body.error });
            return;
          case "home_offline":
            setPhase({ kind: "offline" });
            return;
          default:
            setPhase({
              kind: "error",
              message: body.message || `The share could not be loaded (${res.status}).`,
            });
        }
      } catch {
        setPhase({ kind: "error", message: "The connection service could not be reached." });
      } finally {
        setBusy(false);
      }
    },
    [shareId, relayUrl],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (phase.kind === "ready" && phase.note.title) {
      document.title = `${phase.note.title} — HomeKB`;
    }
  }, [phase]);

  const imageLoader = useMemo(
    () =>
      phase.kind === "ready"
        ? makeShareImageLoader(relayUrl, shareId, unlockedPassword, phase.note.path)
        : null,
    [phase, relayUrl, shareId, unlockedPassword],
  );

  return (
    <main className="min-h-dvh">
      <div className="mx-auto w-full max-w-2xl px-4 py-8 pb-[max(env(safe-area-inset-bottom),48px)]">
        {phase.kind === "loading" && (
          <div className="flex justify-center py-24 text-hk-coral-text">
            <Spinner size={22} />
          </div>
        )}

        {phase.kind === "password" && (
          <form
            className="mx-auto mt-16 max-w-sm rounded-2xl border border-hk-border bg-hk-card p-6"
            onSubmit={(e) => {
              e.preventDefault();
              if (passwordInput) void load(passwordInput);
            }}
          >
            <h1 className="text-[17px] font-semibold text-hk-text">This note is protected</h1>
            <p className="mt-1 text-[13.5px] text-hk-text-2">
              Enter the password the author gave you.
            </p>
            <input
              type="password"
              autoFocus
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              className="mt-4 w-full rounded-xl border border-hk-input-border bg-hk-card-soft px-3.5 py-2.5 text-[14px] text-hk-text outline-none focus:border-hk-input-focus"
              placeholder="Password"
            />
            {phase.error && (
              <p className="mt-2 text-[13px] text-hk-orange-text">{phase.error}</p>
            )}
            <button
              type="submit"
              disabled={busy || !passwordInput}
              className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl bg-hk-coral px-3.5 py-2.5 text-[13.5px] font-semibold text-hk-on-coral transition-colors hover:bg-hk-coral-hover disabled:opacity-60"
            >
              {busy && <Spinner size={12} />}
              Open note
            </button>
          </form>
        )}

        {phase.kind === "gone" && (
          <StatusCard
            title={phase.error === "share_expired" ? "This link has expired" : "Nothing here"}
            body={
              phase.error === "share_expired"
                ? "The author set an expiry on this share and it has passed."
                : "This share does not exist or has been revoked by its author."
            }
          />
        )}

        {phase.kind === "offline" && (
          <StatusCard
            title="The author's library is offline"
            body="This note is served live from its author's own computer, which is not connected right now. Try again later."
            retry={() => {
              setPhase({ kind: "loading" });
              void load(unlockedPassword ?? undefined);
            }}
          />
        )}

        {phase.kind === "error" && (
          <StatusCard
            title="Could not load this share"
            body={phase.message}
            retry={() => {
              setPhase({ kind: "loading" });
              void load(unlockedPassword ?? undefined);
            }}
          />
        )}

        {phase.kind === "ready" && imageLoader && (
          <>
            <article className="hk-domd">
              <DOMDProvider
                editable={false}
                initMd={phase.note.content}
                imageLoader={imageLoader}
              >
                <DOMD />
              </DOMDProvider>
            </article>
            <footer className="mt-12 border-t border-hk-border pt-4 text-center text-[12px] text-hk-faint">
              Served live from the author&apos;s own computer ·{" "}
              <span className="font-semibold">HomeKB</span>
            </footer>
          </>
        )}
      </div>
    </main>
  );
}

function StatusCard({
  title,
  body,
  retry,
}: {
  title: string;
  body: string;
  retry?: () => void;
}) {
  return (
    <div className="mx-auto mt-16 max-w-sm rounded-2xl border border-hk-border bg-hk-card p-6 text-center">
      <h1 className="text-[17px] font-semibold text-hk-text">{title}</h1>
      <p className="mt-2 text-[13.5px] leading-relaxed text-hk-text-2">{body}</p>
      {retry && (
        <button
          onClick={retry}
          className="mt-4 rounded-xl border border-hk-border px-3.5 py-1.5 text-[13px] font-semibold text-hk-text-2 transition-colors hover:bg-hk-card-soft"
        >
          Try again
        </button>
      )}
    </div>
  );
}
