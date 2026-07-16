"use client";

/**
 * Web connect / landing (design 8a/8b): where a remote device connects to home.
 * No app nav (not connected yet), and **no mode choice** — the mental model is
 * "scan the QR from your home computer, or type the pairing code". Scan path exposes
 * nothing else (the QR carries the service URL + code). Manual path shows the service
 * address field — without scanning, the client cannot know which service the home
 * registered with (docs/ARCHITECTURE.md "Client connection model").
 *
 * Phone (coarse pointer + camera): scan-first (8b) — camera viewfinder decoding the
 * home machine's pairing QR; "Enter code manually" reveals the code form.
 * Desktop (8a): manual-first + a coral "On your phone? Scan the QR instead" link.
 *
 * Supports the pairing-link contract (docs/ARCHITECTURE.md "Pairing link (QR payload)"):
 * `/?relay=<url>&code=<code>` prefill + auto-claim, params stripped immediately.
 */

import { useEffect, useRef, useState } from "react";
import { defaultRelayUrl, type PairingLink } from "@/lib/client/connection";
import { useKbStore, useKbStoreApi } from "../store/kb-store";
import { Spinner } from "./icons";
import { canScanQr, isCoarsePointer, QrScanner } from "./qr-scanner";

const inputCls =
  "w-full rounded-xl border border-hk-input-border bg-hk-card-soft px-3.5 py-2.5 text-[14px] text-hk-text outline-none placeholder:text-hk-weak focus:border-hk-input-focus";

/** Pairing link in the address bar (auto-claim path) — skip the scanner then. */
function hasLinkParams(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return !!(params.get("relay") || params.get("code"));
}

export function PairScreen() {
  const api = useKbStoreApi();
  const busy = useKbStore((s) => s.state.pairBusy);
  const error = useKbStore((s) => s.state.pairError);
  const [serviceUrl, setServiceUrl] = useState(defaultRelayUrl());
  const [code, setCode] = useState("");
  // 8b scan-first on phones with a camera; desktops land on the manual form.
  const [scanning, setScanning] = useState(
    () => canScanQr() && isCoarsePointer() && !hasLinkParams(),
  );
  const [cameraNote, setCameraNote] = useState<string | null>(null);
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
    if (linkRelay) setServiceUrl(linkRelay);
    if (linkCode) setCode(linkCode.toUpperCase());
    if (linkRelay && linkCode) {
      void api.pairRelay(linkRelay.trim(), linkCode.trim().toUpperCase());
    }
  }, [api]);

  const ready = code.trim().length >= 4 && serviceUrl.trim().length > 0;

  // Scanned QR → prefill and claim immediately; the form takes over the busy/error
  // display (a failed claim lands the user on the filled-in form).
  const handleScan = (link: PairingLink) => {
    setScanning(false);
    setServiceUrl(link.relayUrl);
    setCode(link.code);
    void api.pairRelay(link.relayUrl, link.code);
  };

  if (scanning) {
    return (
      <div className="fixed inset-0 overflow-y-auto">
        <main className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center px-5 pt-[max(env(safe-area-inset-top),24px)] pb-[max(env(safe-area-inset-bottom),24px)]">
          <h1 className="text-center text-[30px] font-bold tracking-tight text-hk-heading">
            HomeKB
          </h1>
          <p className="mt-2 text-center text-[14px] text-hk-text-2">
            Your knowledge base lives on your own computer.
          </p>
          <div className="mt-8 flex flex-col items-center">
            <QrScanner
              onResult={handleScan}
              onUnavailable={(msg) => {
                setScanning(false);
                setCameraNote(msg);
              }}
            />
            <button
              type="button"
              onClick={() => setScanning(false)}
              className="mt-6 text-[14px] font-semibold text-hk-coral-text transition-colors hover:text-hk-coral-hover"
            >
              Enter code manually
            </button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 overflow-y-auto">
      <main className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center px-5 pt-[max(env(safe-area-inset-top),24px)] pb-[max(env(safe-area-inset-bottom),24px)]">
        <h1 className="text-center text-[30px] font-bold tracking-tight text-hk-heading">
          HomeKB
        </h1>
        <p className="mt-2 text-center text-[14px] text-hk-text-2">
          Your knowledge base lives on your own computer.
        </p>
        {cameraNote && (
          <p className="mt-3 text-center text-[12.5px] text-hk-orange-text">{cameraNote}</p>
        )}

        <form
          className="mt-8 flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) void api.pairRelay(serviceUrl.trim(), code.trim());
          }}
        >
          <p className="text-[12.5px] leading-relaxed text-hk-weak">
            Get a pairing code from HomeKB on your home computer (the Remote tab), or run{" "}
            <code className="font-mono text-[11.5px] text-hk-text-2">homekb pair</code>.
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-hk-weak">Pairing code</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="A7KM2XQ9"
              maxLength={8}
              autoFocus
              className={`${inputCls} text-center font-mono text-[18px] tracking-[0.3em] uppercase`}
              autoComplete="one-time-code"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-hk-weak">Service address</span>
            <input
              value={serviceUrl}
              onChange={(e) => setServiceUrl(e.target.value)}
              placeholder="https://relay.example.com"
              className={`${inputCls} font-mono text-[12.5px]`}
              autoCapitalize="none"
              autoCorrect="off"
            />
            <span className="text-[11.5px] leading-relaxed text-hk-faint">
              The service your home computer is connected to — shown next to the pairing
              code in its Remote tab. Scanning the QR fills everything in automatically.
            </span>
          </label>
          {error && <p className="text-center text-[13px] text-hk-orange-text">{error}</p>}
          <button
            type="submit"
            disabled={busy || !ready}
            className="mt-1 flex items-center justify-center gap-2 rounded-xl bg-hk-coral px-4 py-3 text-[15px] font-semibold text-hk-on-coral transition-colors hover:bg-hk-coral-hover disabled:opacity-50"
          >
            {busy && <Spinner size={15} />}
            Connect
          </button>
          <p className="text-center text-[11.5px] leading-relaxed text-hk-faint">
            Nothing is stored in between — the service only moves data between you and
            your computer.
          </p>
        </form>

        {canScanQr() && (
          <button
            type="button"
            onClick={() => {
              setCameraNote(null);
              setScanning(true);
            }}
            className="mt-5 text-center text-[13.5px] font-semibold text-hk-coral-text transition-colors hover:text-hk-coral-hover"
          >
            {isCoarsePointer() ? "Scan the QR code instead" : "On your phone? Scan the QR instead"}
          </button>
        )}
      </main>
    </div>
  );
}
