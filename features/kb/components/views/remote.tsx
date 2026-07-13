"use client";

/**
 * Remote tab (design 7b): the device-connection hub, elevated out of Settings.
 * - Desktop (home machine): pairing card (QR + code + expiry + regenerate),
 *   connection card (relay URL / device name / keep-tunnel-alive), relay signup.
 * - Web (remote client): current connection + in-app confirmed disconnect.
 * The relay only forwards traffic — it never stores notes. No OS dialogs, ever.
 */

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { DesktopNotice } from "@/features/desktop/components/notice";
import { getConnection } from "@/lib/client/connection";
import { isDesktop } from "@/lib/client/desktop";
import {
  useDesktopStore,
  useDesktopStoreApi,
} from "@/features/desktop/store/desktop-store";
import { useKbStore, useKbStoreApi } from "../../store/kb-store";
import { IconCopy, IconPhoneSignal, IconRefresh, Spinner, StatusDot } from "../icons";

function Card({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-hk-border bg-hk-card p-4">
      {title && <div className="hk-label">{title}</div>}
      <div className={title ? "mt-3" : ""}>{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 text-[13.5px]">
      <span className="shrink-0 text-hk-weak">{label}</span>
      <span className="truncate font-mono text-[12px] text-hk-text-2">{value}</span>
    </div>
  );
}

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${
        checked ? "bg-hk-coral" : "bg-hk-pill"
      } ${disabled ? "opacity-50" : ""}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-[left] ${
          checked ? "left-[18px]" : "left-0.5"
        }`}
        style={{ boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }}
      />
    </button>
  );
}

function countdown(expiresAt: number, now: number): string | null {
  const ms = expiresAt - now;
  if (ms <= 0) return null;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Pairing link contract: docs/ARCHITECTURE.md "Pairing link (QR payload)". */
function pairingLink(relayUrl: string, code: string): string {
  const webBase = process.env.NEXT_PUBLIC_WEB_URL || "http://localhost:3000";
  return `${webBase}/?relay=${encodeURIComponent(relayUrl)}&code=${encodeURIComponent(code)}`;
}

function PairingCard() {
  const api = useDesktopStoreApi();
  const pair = useDesktopStore((s) => s.state.pair);
  const busy = useDesktopStore((s) => s.state.pairBusy);
  const error = useDesktopStore((s) => s.state.pairError);
  const [qr, setQr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!pair) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pair]);

  useEffect(() => {
    setQr(null);
    if (!pair) return;
    let cancelled = false;
    QRCode.toDataURL(pairingLink(pair.relayUrl, pair.code), {
      margin: 0,
      width: 320,
      color: { dark: "#141310", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => {
        // QR is a convenience; the code + link still work without it.
      });
    return () => {
      cancelled = true;
    };
  }, [pair]);

  const remain = pair ? countdown(pair.expiresAt, now) : null;

  const copy = async () => {
    if (!pair) return;
    try {
      await navigator.clipboard.writeText(pair.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable; the code is on screen anyway.
    }
  };

  return (
    <Card title="Pair a new device">
      {pair && remain ? (
        <div className="flex flex-col items-center gap-3 py-1">
          {qr ? (
            // White tile keeps the QR scannable in both themes
            <div className="rounded-2xl bg-white p-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL */}
              <img src={qr} alt="Pairing QR code" className="h-40 w-40" />
            </div>
          ) : (
            <div className="flex h-40 w-40 items-center justify-center rounded-2xl bg-hk-card-strong text-hk-coral-text">
              <Spinner size={20} />
            </div>
          )}
          <button
            onClick={copy}
            className="flex items-center gap-2 font-mono text-[26px] font-bold tracking-[0.25em] text-hk-heading"
            title="Copy code"
          >
            {pair.code}
            <span className="text-hk-weak">
              <IconCopy size={15} />
            </span>
          </button>
          <div className="text-xs text-hk-faint">
            {copied ? "Copied" : `Expires in ${remain}`} · scan with your phone, or enter the
            code on the connect screen
          </div>
        </div>
      ) : (
        <p className="text-[13px] leading-relaxed text-hk-text-2">
          {pair ? "The code expired. " : ""}
          Generate a code, then scan the QR with your phone — or type the code into the
          HomeKB connect screen or Claude&apos;s connector authorization page.
        </p>
      )}
      {error && <p className="mt-2 text-xs text-hk-orange-text">{error}</p>}
      <button
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-hk-coral px-4 py-2.5 text-[14px] font-semibold text-hk-on-coral transition-colors hover:bg-hk-coral-hover disabled:opacity-60"
        disabled={busy}
        onClick={() => void api.newPairCode()}
      >
        {busy ? <Spinner size={14} /> : <IconRefresh size={14} />}
        {pair && remain ? "Generate new code" : "Generate pairing code"}
      </button>
    </Card>
  );
}

function DesktopRemote() {
  const api = useDesktopStoreApi();
  const engine = useDesktopStore((s) => s.state.engine);
  const tunnelRunning = useDesktopStore((s) => s.state.tunnelRunning);
  const tunnelBusy = useDesktopStore((s) => s.state.tunnelBusy);
  const registerDraft = useDesktopStore((s) => s.state.registerDraft);
  const registerBusy = useDesktopStore((s) => s.state.registerBusy);
  const registerError = useDesktopStore((s) => s.state.registerError);

  useEffect(() => {
    void api.refreshEngine();
  }, [api]);

  if (!engine?.relay) {
    return (
      <Card title="Remote access">
        <p className="text-[13px] leading-relaxed text-hk-text-2">
          Register this computer with a relay so your phone and Claude can reach it. The
          relay only forwards traffic — it never stores your notes.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            className="min-w-0 flex-1 rounded-xl border border-hk-input-border bg-transparent px-3 py-2 font-mono text-[13px] text-hk-text outline-none placeholder:text-hk-weak focus:border-hk-input-focus"
            placeholder="https://relay.example.com"
            value={registerDraft}
            onChange={(e) => api.setRegisterDraft(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
          />
          <button
            className="flex items-center gap-1.5 rounded-xl bg-hk-coral px-4 py-2 text-[13.5px] font-semibold text-hk-on-coral transition-colors hover:bg-hk-coral-hover disabled:opacity-60"
            disabled={registerBusy || !registerDraft.trim()}
            onClick={() => void api.register()}
          >
            {registerBusy && <Spinner size={13} />}
            Register
          </button>
        </div>
        {registerError && <p className="mt-2 text-xs text-hk-orange-text">{registerError}</p>}
      </Card>
    );
  }

  return (
    <>
      <PairingCard />
      <Card title="Connection">
        <Row label="Relay" value={engine.relay.url} />
        <Row label="This device" value={engine.relay.name} />
        <div className="mt-2 flex items-center justify-between gap-4 border-t border-hk-hairline pt-3">
          <span className="text-[13.5px] text-hk-text-2">
            Keep tunnel alive
            <span className="block text-xs text-hk-faint">
              Required for mobile / remote MCP
            </span>
          </span>
          <Toggle
            checked={tunnelRunning}
            disabled={tunnelBusy}
            onChange={() => void api.toggleTunnel()}
          />
        </div>
      </Card>
    </>
  );
}

function WebRemote() {
  const api = useKbStoreApi();
  const homeName = useKbStore((s) => s.state.homeName);
  const connState = useKbStore((s) => s.connState);
  const [confirming, setConfirming] = useState(false);
  const conn = getConnection();

  return (
    <>
      <Card title="This device">
        <Row label="Connected to" value={homeName || "Home"} />
        {conn?.mode === "relay" && <Row label="Relay" value={conn.relayUrl} />}
        {conn?.mode === "direct" && <Row label="Address" value={conn.baseUrl} />}
        <Row
          label="Mode"
          value={conn?.mode === "direct" ? "direct — no relay in between" : "relay"}
        />
        <div className="mt-2 flex items-center gap-2 border-t border-hk-hairline pt-3 text-[13px] text-hk-text-2">
          <span
            className={
              connState === "online"
                ? "text-hk-green"
                : connState === "connecting"
                  ? "text-hk-amber"
                  : "text-hk-orange"
            }
          >
            <StatusDot />
          </span>
          {connState === "online"
            ? "Home is reachable"
            : connState === "connecting"
              ? "Connecting to home…"
              : "Home is offline"}
        </div>
      </Card>

      <Card>
        <p className="text-[13px] leading-relaxed text-hk-text-2">
          Disconnecting removes this device&apos;s access token. You can pair again anytime
          with a fresh code from your home computer.
        </p>
        {confirming ? (
          <div className="mt-3 flex gap-2">
            <button
              className="flex-1 rounded-xl border border-hk-border px-4 py-2.5 text-[14px] font-semibold text-hk-text-2 transition-colors hover:bg-hk-card"
              onClick={() => setConfirming(false)}
            >
              Keep connected
            </button>
            <button
              className="flex-1 rounded-xl bg-hk-coral px-4 py-2.5 text-[14px] font-semibold text-hk-on-coral transition-colors hover:bg-hk-coral-hover"
              onClick={() => api.unpair()}
            >
              Disconnect
            </button>
          </div>
        ) : (
          <button
            className="mt-3 w-full rounded-xl border border-hk-border px-4 py-2.5 text-[14px] font-semibold text-hk-text-2 transition-colors hover:bg-hk-card"
            onClick={() => setConfirming(true)}
          >
            Disconnect this device…
          </button>
        )}
      </Card>
    </>
  );
}

export function RemoteView() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-xl px-4 py-5 pb-[max(env(safe-area-inset-bottom),24px)]">
        <div className="flex items-center gap-2.5">
          <span className="text-hk-weak">
            <IconPhoneSignal size={18} strokeWidth={1.5} />
          </span>
          <h1 className="text-[21px] font-bold tracking-tight text-hk-heading">Remote</h1>
        </div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-hk-text-2">
          Connect your phone or Claude to this home. The relay only forwards traffic — it
          never stores your notes.
        </p>
        <div className="mt-4 flex flex-col gap-3">
          {isDesktop() ? (
            <>
              <DesktopRemote />
              <DesktopNotice />
            </>
          ) : (
            <WebRemote />
          )}
        </div>
      </div>
    </div>
  );
}
