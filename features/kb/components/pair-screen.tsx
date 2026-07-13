"use client";

/**
 * Web connect / landing (design 8a/8b): where a remote device connects to home.
 * No app nav (not connected yet). Direct is the default tab — "your browser talks
 * straight to your computer" is the headline story; relay is the secondary path.
 *
 * Supports the pairing-link contract (docs/ARCHITECTURE.md "Pairing link (QR payload)"):
 * `/?relay=<url>&code=<code>` prefill + auto-claim, params stripped immediately.
 */

import { useEffect, useRef, useState } from "react";
import { defaultRelayUrl } from "@/lib/client/connection";
import { useKbStore, useKbStoreApi } from "../store/kb-store";
import { Spinner } from "./icons";

type PairMode = "direct" | "relay";

const inputCls =
  "w-full rounded-xl border border-hk-input-border bg-hk-card-soft px-3.5 py-2.5 text-[14px] text-hk-text outline-none placeholder:text-hk-weak focus:border-hk-input-focus";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-hk-weak">{label}</span>
      {children}
    </label>
  );
}

export function PairScreen() {
  const api = useKbStoreApi();
  const busy = useKbStore((s) => s.state.pairBusy);
  const error = useKbStore((s) => s.state.pairError);
  const [mode, setMode] = useState<PairMode>("direct");
  const [relayUrl, setRelayUrl] = useState(defaultRelayUrl());
  const [code, setCode] = useState("");
  const [directUrl, setDirectUrl] = useState("");
  const [directToken, setDirectToken] = useState("");
  const autoClaimed = useRef(false);

  // Pairing link (QR payload): prefill + auto-claim, then scrub the address bar.
  useEffect(() => {
    if (autoClaimed.current) return;
    const params = new URLSearchParams(window.location.search);
    const linkRelay = params.get("relay");
    const linkCode = params.get("code");
    if (!linkRelay && !linkCode) return;
    autoClaimed.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    if (linkRelay) setRelayUrl(linkRelay);
    if (linkCode) setCode(linkCode.toUpperCase());
    setMode("relay");
    if (linkRelay && linkCode) {
      void api.pairRelay(linkRelay.trim(), linkCode.trim().toUpperCase());
    }
  }, [api]);

  const relayReady = code.trim().length >= 4 && relayUrl.trim().length > 0;
  const directReady = directUrl.trim().length > 0 && directToken.trim().length > 0;

  return (
    <div className="fixed inset-0 overflow-y-auto">
      <main className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center px-5 pt-[max(env(safe-area-inset-top),24px)] pb-[max(env(safe-area-inset-bottom),24px)]">
        <h1 className="text-center text-[30px] font-bold tracking-tight text-hk-heading">
          HomeKB
        </h1>
        <p className="mt-2 text-center text-[14px] text-hk-text-2">
          Your knowledge base lives on your own computer.
        </p>

        {/* Segmented tabs — Connect directly is the default */}
        <div
          role="tablist"
          className="mt-7 flex rounded-xl border border-hk-hairline bg-hk-card-soft p-1"
        >
          {(
            [
              ["direct", "Connect directly"],
              ["relay", "Use a relay"],
            ] as [PairMode, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              role="tab"
              type="button"
              aria-selected={mode === m}
              className={`flex-1 rounded-[9px] px-3 py-1.5 text-[13px] font-semibold transition-colors ${
                mode === m ? "bg-hk-pill text-hk-heading" : "text-hk-weak hover:text-hk-text-2"
              }`}
              onClick={() => setMode(m)}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "direct" ? (
          <form
            className="mt-5 flex flex-col gap-3.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (directReady) void api.pairDirect(directUrl.trim(), directToken.trim());
            }}
          >
            <p className="text-[12.5px] leading-relaxed text-hk-weak">
              Your computer is reachable at a public address — run{" "}
              <code className="font-mono text-[11.5px] text-hk-text-2">
                homekb serve --host 0.0.0.0
              </code>{" "}
              on it to get the address and token.
            </p>
            <Field label="Home address">
              <input
                value={directUrl}
                onChange={(e) => setDirectUrl(e.target.value)}
                placeholder="https://home.example.com:8765"
                autoFocus
                className={`${inputCls} font-mono text-[13px]`}
                autoCapitalize="none"
                autoCorrect="off"
              />
            </Field>
            <Field label="Token">
              <input
                value={directToken}
                onChange={(e) => setDirectToken(e.target.value)}
                placeholder="hkd_…"
                type="password"
                className={`${inputCls} font-mono text-[13px]`}
                autoComplete="off"
              />
            </Field>
            {error && <p className="text-center text-[13px] text-hk-orange-text">{error}</p>}
            <button
              type="submit"
              disabled={busy || !directReady}
              className="mt-1 flex items-center justify-center gap-2 rounded-xl bg-hk-coral px-4 py-3 text-[15px] font-semibold text-hk-on-coral transition-colors hover:bg-hk-coral-hover disabled:opacity-50"
            >
              {busy && <Spinner size={15} />}
              Connect
            </button>
            <p className="text-center text-[11.5px] leading-relaxed text-hk-faint">
              Direct mode — your browser talks straight to your computer, no relay in
              between.
            </p>
          </form>
        ) : (
          <form
            className="mt-5 flex flex-col gap-3.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (relayReady) void api.pairRelay(relayUrl.trim(), code.trim());
            }}
          >
            <p className="text-[12.5px] leading-relaxed text-hk-weak">
              Run <code className="font-mono text-[11.5px] text-hk-text-2">homekb pair</code>{" "}
              on your home computer — or open the Remote tab in the HomeKB app — to get a
              pairing code.
            </p>
            <Field label="Pairing code">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="A7KM2XQ9"
                maxLength={8}
                autoFocus
                className={`${inputCls} text-center font-mono text-[18px] tracking-[0.3em] uppercase`}
                autoComplete="one-time-code"
              />
            </Field>
            <Field label="Relay server">
              <input
                value={relayUrl}
                onChange={(e) => setRelayUrl(e.target.value)}
                placeholder="https://relay.example.com"
                className={`${inputCls} font-mono text-[12.5px]`}
                autoCapitalize="none"
                autoCorrect="off"
              />
            </Field>
            {error && <p className="text-center text-[13px] text-hk-orange-text">{error}</p>}
            <button
              type="submit"
              disabled={busy || !relayReady}
              className="mt-1 flex items-center justify-center gap-2 rounded-xl bg-hk-coral px-4 py-3 text-[15px] font-semibold text-hk-on-coral transition-colors hover:bg-hk-coral-hover disabled:opacity-50"
            >
              {busy && <Spinner size={15} />}
              Connect
            </button>
            <p className="text-center text-[11.5px] leading-relaxed text-hk-faint">
              The relay only moves data between you and your computer — nothing is stored
              on it.
            </p>
          </form>
        )}
      </main>
    </div>
  );
}
