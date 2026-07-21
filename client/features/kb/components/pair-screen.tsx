"use client";

/**
 * Web connect / landing (design 8a/8b): where a remote device connects to home.
 * No app nav (not connected yet), and **no mode choice** — the mental model is
 * "scan the QR from your home computer, or type the pairing code". Scan path exposes
 * nothing else (the QR carries the service URL + code). Manual path shows the service
 * address field — without scanning, the client cannot know which service the home
 * registered with (docs/ARCHITECTURE.md "Client connection model").
 *
 * Every device lands on the pairing-code form (the Service address comes prefilled
 * with the official default, so the user usually only types the code). QR scanning is
 * demoted to a "Scan the QR code instead" action below the form — one tap away, never
 * the first thing shown, since leading with the camera adds friction.
 *
 * Supports the pairing-link contract (docs/ARCHITECTURE.md "Pairing link (QR payload)"):
 * `/?relay=<url>&code=<code>` prefill + auto-claim, params stripped immediately.
 */

import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { defaultRelayUrl, type PairingLink } from "@/lib/client/connection";
import { useKbStore, useKbStoreApi } from "../store/kb-store";
import { Spinner } from "./icons";
import { canScanQr, isCoarsePointer, QrScanner } from "./qr-scanner";

const inputCls =
  "w-full rounded-xl border border-base-300 bg-base-200 px-3.5 py-2.5 text-[14px] text-base-content outline-none placeholder:text-base-content/45 focus:border-base-content/30";

export function PairScreen() {
  const { t } = useTranslation();
  const api = useKbStoreApi();
  const busy = useKbStore((s) => s.state.pairBusy);
  const error = useKbStore((s) => s.state.pairError);
  const [serviceUrl, setServiceUrl] = useState(defaultRelayUrl());
  const [code, setCode] = useState("");
  // Pairing-code entry is the default surface on every device (phone included) —
  // leading with the camera adds friction. QR scanning stays one tap below the form.
  const [scanning, setScanning] = useState(false);
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
          <h1 className="text-center text-[30px] font-bold tracking-tight text-base-content">
            HomeKB
          </h1>
          <p className="mt-2 text-center text-[14px] text-base-content/60">
            {t("pair.tagline")}
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
              className="mt-6 text-[14px] font-semibold text-primary transition-colors hover:text-primary"
            >
              {t("pair.enterCodeManually")}
            </button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 overflow-y-auto">
      <main className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center px-5 pt-[max(env(safe-area-inset-top),24px)] pb-[max(env(safe-area-inset-bottom),24px)]">
        <h1 className="text-center text-[30px] font-bold tracking-tight text-base-content">
          HomeKB
        </h1>
        <p className="mt-2 text-center text-[14px] text-base-content/60">
          {t("pair.tagline")}
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
          <p className="text-[12.5px] leading-relaxed text-base-content/45">
            <Trans
              i18nKey="pair.getCodeHint"
              components={{
                code: <code className="font-mono text-[11.5px] text-base-content/60" />,
              }}
            />
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-base-content/45">
              {t("pair.pairingCode")}
            </span>
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
            <span className="text-[12px] font-medium text-base-content/45">
              {t("pair.serviceAddress")}
            </span>
            <input
              value={serviceUrl}
              onChange={(e) => setServiceUrl(e.target.value)}
              placeholder="https://relay.example.com"
              className={`${inputCls} font-mono text-[12.5px]`}
              autoCapitalize="none"
              autoCorrect="off"
            />
            <span className="text-[11.5px] leading-relaxed text-base-content/35">
              {t("pair.serviceAddressHint")}
            </span>
          </label>
          {error && <p className="text-center text-[13px] text-hk-orange-text">{error}</p>}
          <button
            type="submit"
            disabled={busy || !ready}
            className="mt-1 flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-[15px] font-semibold text-primary-content transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {busy && <Spinner size={15} />}
            {t("pair.connect")}
          </button>
          <p className="text-center text-[11.5px] leading-relaxed text-base-content/35">
            {t("pair.privacyNote")}
          </p>
        </form>

        {canScanQr() && (
          <button
            type="button"
            onClick={() => {
              setCameraNote(null);
              setScanning(true);
            }}
            className="mt-5 text-center text-[13.5px] font-semibold text-primary transition-colors hover:text-primary"
          >
            {isCoarsePointer() ? t("pair.scanInstead") : t("pair.scanInsteadDesktop")}
          </button>
        )}
      </main>
    </div>
  );
}
