"use client";

/**
 * Remote tab (design 7b): the device-connection hub, elevated out of Settings.
 * - Desktop (home machine): connection-service setup, then pairing card
 *   (QR + code + expiry + regenerate), connection card, paired devices.
 * - Web (remote client): current connection + in-app confirmed disconnect.
 * The service only forwards traffic — it never stores notes. No OS dialogs, ever.
 */

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { DesktopNotice } from "@/features/desktop/components/notice";
import { getConnection } from "@/lib/client/connection";
import { isDesktop } from "@/lib/client/desktop";
import { isAllowedServiceUrl } from "@/lib/client/services";
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
    <section className="rounded-xl bg-base-200 p-4">
      {title && <div className="hk-label">{title}</div>}
      <div className={title ? "mt-3" : ""}>{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 text-[13.5px]">
      <span className="shrink-0 text-base-content/45">{label}</span>
      <span className="truncate font-mono text-[12px] text-base-content/60">{value}</span>
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
        checked ? "bg-primary" : "bg-base-300"
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

/**
 * Fixed Web UI origin for QR links (docs "Pairing link (QR payload)") — never
 * user-configured. The in-app scanner reads only the query params; the base just
 * makes the same QR openable from a native camera once the official domain is live.
 * A web client composes links against its own origin — it *is* the Web UI
 * (docs "Paired-device equivalence"), same fixed-origin rule.
 */
const WEB_BASE = (process.env.NEXT_PUBLIC_WEB_URL || "http://localhost:3000").replace(/\/+$/, "");

function webBase(): string {
  if (!isDesktop() && typeof window !== "undefined") return window.location.origin;
  return WEB_BASE;
}

/** Relay pairing link contract: docs/ARCHITECTURE.md "Pairing link (QR payload)". */
function relayPairingLink(relayUrl: string, code: string): string {
  return `${webBase()}/?relay=${encodeURIComponent(relayUrl)}&code=${encodeURIComponent(code)}`;
}

/** Small QR data-url hook for the pairing card. */
function useQrDataUrl(link: string | null): string | null {
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    setQr(null);
    if (!link) return;
    let cancelled = false;
    QRCode.toDataURL(link, {
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
  }, [link]);
  return qr;
}

/**
 * Shared pairing card (docs "Paired-device equivalence"): QR + code + expiry +
 * regenerate. Purely presentational — the desktop binds the DesktopStore
 * (`pair_new` via the engine's homeSecret), the web binds the KbStore
 * (relay `{action:"new"}` with its own clientToken).
 */
function PairingCard({
  pair,
  busy,
  error,
  onGenerate,
}: {
  pair: { code: string; expiresAt: number; relayUrl: string } | null;
  busy: boolean;
  error: string | null;
  onGenerate: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const qr = useQrDataUrl(pair ? relayPairingLink(pair.relayUrl, pair.code) : null);

  useEffect(() => {
    if (!pair) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
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
            <div className="rounded-xl bg-white p-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL */}
              <img src={qr} alt="Pairing QR code" className="h-40 w-40" />
            </div>
          ) : (
            <div className="flex h-40 w-40 items-center justify-center rounded-xl bg-base-300 text-primary">
              <Spinner size={20} />
            </div>
          )}
          <button
            onClick={copy}
            className="flex items-center gap-2 font-mono text-[26px] font-bold tracking-[0.25em] text-base-content"
            title="Copy code"
          >
            {pair.code}
            <span className="text-base-content/45">
              <IconCopy size={15} />
            </span>
          </button>
          <div className="text-xs text-base-content/35">
            {copied ? "Copied" : `Expires in ${remain}`} · scan with your phone, or enter the
            code on the connect screen
          </div>
        </div>
      ) : (
        <p className="text-[13px] leading-relaxed text-base-content/60">
          {pair ? "The code expired. " : ""}
          Generate a code, then scan the QR with your phone — or type the code into the
          HomeKB connect screen or Claude&apos;s connector authorization page.
        </p>
      )}
      {error && <p className="mt-2 text-xs text-hk-orange-text">{error}</p>}
      <button
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-[14px] font-semibold text-primary-content transition-colors hover:bg-primary/90 disabled:opacity-60"
        disabled={busy}
        onClick={onGenerate}
      >
        {busy ? <Spinner size={14} /> : <IconRefresh size={14} />}
        {pair && remain ? "Generate new code" : "Generate pairing code"}
      </button>
    </Card>
  );
}

/** Desktop binding: pairing state from the DesktopStore (engine-side `homekb pair`). */
function DesktopPairingCard() {
  const api = useDesktopStoreApi();
  const pair = useDesktopStore((s) => s.state.pair);
  const busy = useDesktopStore((s) => s.state.pairBusy);
  const error = useDesktopStore((s) => s.state.pairError);
  return (
    <PairingCard pair={pair} busy={busy} error={error} onGenerate={() => void api.newPairCode()} />
  );
}

function agoLabel(ts: number | null): string {
  if (!ts) return "never used";
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (mins < 1) return "active just now";
  if (mins < 60) return `active ${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `active ${hours} h ago`;
  return `active ${Math.round(hours / 24)} d ago`;
}

/** One paired device row: label + activity, with an in-app confirmed Unpair. */
function DeviceRow({
  grant,
  border,
  busy,
  onRevoke,
}: {
  grant: { id: string; label: string; createdAt: number; lastUsedAt: number | null; self?: boolean };
  border: boolean;
  busy: boolean;
  onRevoke: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div
      className={`flex items-center gap-3 py-2.5 ${border ? "border-t border-base-200" : ""}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-base-content">
          {grant.label || "Unnamed device"}
          {grant.self && (
            <span className="ml-2 rounded-full bg-base-300 px-2 py-0.5 text-[10.5px] font-semibold text-base-content/60">
              This device
            </span>
          )}
        </span>
        <span className="block text-xs text-base-content/35">
          Paired {new Date(grant.createdAt).toLocaleDateString()} · {agoLabel(grant.lastUsedAt)}
        </span>
      </span>
      {confirming ? (
        <span className="flex shrink-0 items-center gap-2">
          <button
            className="text-[12.5px] font-medium text-base-content/45 transition-colors hover:text-base-content/60"
            onClick={() => setConfirming(false)}
          >
            Keep
          </button>
          <button
            className="flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-[12.5px] font-semibold text-primary-content transition-colors hover:bg-primary/90 disabled:opacity-60"
            disabled={busy}
            onClick={onRevoke}
          >
            {busy && <Spinner size={11} />}
            {grant.self ? "Disconnect" : "Unpair"}
          </button>
        </span>
      ) : (
        <button
          className="shrink-0 text-[12.5px] font-medium text-base-content/45 transition-colors hover:text-hk-orange-text"
          onClick={() => setConfirming(true)}
        >
          {grant.self ? "Disconnect" : "Unpair"}
        </button>
      )}
    </div>
  );
}

/**
 * Paired devices (design 7b, all platforms — docs "Paired-device equivalence"):
 * every grant this home has issued at the relay. The relay stores only labels +
 * token hashes — no per-device liveness exists (docs/ARCHITECTURE.md grants
 * API), so rows show last activity instead of a dot. Presentational; the
 * desktop binds homeSecret-authed calls, the web its own clientToken.
 */
function PairedDevicesCard({
  grants,
  loaded,
  error,
  revokingId,
  onRevoke,
}: {
  grants: { id: string; label: string; createdAt: number; lastUsedAt: number | null; self?: boolean }[];
  loaded: boolean;
  error: string | null;
  revokingId: string | null;
  onRevoke: (id: string) => void;
}) {
  return (
    <Card title="Paired devices">
      {error ? (
        <p className="text-xs text-hk-orange-text">{error}</p>
      ) : !loaded ? (
        <div className="flex justify-center py-3 text-primary">
          <Spinner size={16} />
        </div>
      ) : grants.length === 0 ? (
        <p className="text-[13px] leading-relaxed text-base-content/60">
          Nothing is paired yet — generate a code above and scan it with your phone, or
          authorize Claude&apos;s connector with it.
        </p>
      ) : (
        <div className="flex flex-col">
          {grants.map((g, i) => (
            <DeviceRow
              key={g.id}
              grant={g}
              border={i > 0}
              busy={revokingId === g.id}
              onRevoke={() => onRevoke(g.id)}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

/** Desktop binding: grants via the homeSecret-authed relay admin calls. */
function DesktopPairedDevicesCard() {
  const api = useDesktopStoreApi();
  const grants = useDesktopStore((s) => s.state.grants);
  const loaded = useDesktopStore((s) => s.state.grantsLoaded);
  const error = useDesktopStore((s) => s.state.grantsError);
  const revokingId = useDesktopStore((s) => s.state.revokingGrantId);

  useEffect(() => {
    void api.loadGrants();
  }, [api]);

  return (
    <PairedDevicesCard
      grants={grants}
      loaded={loaded}
      error={error}
      revokingId={revokingId}
      onRevoke={(id) => void api.revokeDevice(id)}
    />
  );
}

const addInputCls =
  "min-w-0 flex-1 rounded-xl border border-base-300 bg-transparent px-3 py-2 font-mono text-[12.5px] text-base-content outline-none placeholder:text-base-content/45 focus:border-base-content/30";

/** Reachability dot + latency for one service entry. */
function ProbeBadge({ probe }: { probe: { ok: boolean; ms: number | null } | undefined }) {
  if (!probe) {
    return <span className="text-[11.5px] text-base-content/35">checking…</span>;
  }
  return probe.ok ? (
    <span className="flex items-center gap-1 text-[11.5px] text-success">
      <StatusDot /> {probe.ms} ms
    </span>
  ) : (
    <span className="flex items-center gap-1 text-[11.5px] text-hk-orange">
      <StatusDot /> unreachable
    </span>
  );
}

/**
 * The service picker (docs "Desktop service picker"): built-ins (baked at build;
 * currently none) + user-added entries, each probed for reachability/latency;
 * auto-select prefers a reachable this-machine entry, else the nearest.
 */
function ServicePicker({ onSelected }: { onSelected?: () => void }) {
  const api = useDesktopStoreApi();
  const userServices = useDesktopStore((s) => s.state.userServices);
  const probes = useDesktopStore((s) => s.state.serviceProbes);
  const probing = useDesktopStore((s) => s.state.probing);
  const registerBusy = useDesktopStore((s) => s.state.registerBusy);
  const registerError = useDesktopStore((s) => s.state.registerError);
  const currentUrl = useDesktopStore((s) => s.state.engine?.relay?.url ?? null);
  const services = useDesktopStore((s) => s.services);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    void api.probeServices();
    // Re-probe when the list length changes (entry added/removed).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, userServices.length]);

  const use = async (url: string) => {
    await api.registerWith(url);
    onSelected?.();
  };

  return (
    <div className="flex flex-col gap-3">
      {services.length === 0 ? (
        <p className="text-[12.5px] leading-relaxed text-base-content/35">
          No services available yet — official ones will appear here in a future update.
          Add one you host (or someone shared with you), or start this machine&apos;s own
          service below.
        </p>
      ) : (
        <div className="flex flex-col">
          {services.map((e, i) => (
            <div
              key={e.url}
              className={`flex items-center gap-3 py-2 ${i > 0 ? "border-t border-base-200" : ""}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[12px] text-base-content">
                  {e.url}
                </span>
                <span className="flex items-center gap-2 text-[11px] text-base-content/35">
                  {e.builtin && <span>Built-in</span>}
                  {e.thisMachine && <span>This machine</span>}
                  <ProbeBadge probe={probes[e.url]} />
                </span>
              </span>
              {e.url === currentUrl ? (
                <span className="shrink-0 text-[12px] font-medium text-success">In use</span>
              ) : (
                <button
                  className="shrink-0 rounded-lg bg-primary px-2.5 py-1 text-[12.5px] font-semibold text-primary-content transition-colors hover:bg-primary/90 disabled:opacity-60"
                  disabled={registerBusy || !probes[e.url]?.ok}
                  onClick={() => void use(e.url)}
                >
                  Use
                </button>
              )}
              {!e.builtin && e.url !== currentUrl && (
                <button
                  className="shrink-0 text-[12px] text-base-content/45 transition-colors hover:text-hk-orange-text"
                  onClick={() => api.removeService(e.url)}
                  title="Remove from the list"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          api.addService(draft);
          setDraft("");
        }}
      >
        <input
          className={addInputCls}
          placeholder="https://relay.example.com"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
        />
        <button
          type="submit"
          className="shrink-0 rounded-xl border border-base-300 px-3 py-2 text-[13px] font-semibold text-base-content/60 transition-colors hover:bg-base-200 disabled:opacity-50"
          disabled={!draft.trim()}
        >
          Add
        </button>
      </form>
      <p className="text-[11.5px] leading-relaxed text-base-content/35">
        A service address must be publicly reachable over{" "}
        <span className="font-mono">https://</span> — it is what your phone connects to.
      </p>

      {services.length > 0 && (
        <button
          className="flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-[14px] font-semibold text-primary-content transition-colors hover:bg-primary/90 disabled:opacity-60"
          disabled={registerBusy || probing}
          onClick={() => void api.autoSelectService()}
        >
          {(registerBusy || probing) && <Spinner size={14} />}
          Auto-select the best service
        </button>
      )}
      {registerError && <p className="text-xs text-hk-orange-text">{registerError}</p>}
    </div>
  );
}

/**
 * The single remote concept: a connection service (docs "One remote concept").
 * Unregistered → the picker; registered → pairing QR + connection + devices
 * (with a "Change service" disclosure back into the picker).
 */
function ServiceCard() {
  const api = useDesktopStoreApi();
  const engine = useDesktopStore((s) => s.state.engine);
  const tunnelRunning = useDesktopStore((s) => s.state.tunnelRunning);
  const tunnelBusy = useDesktopStore((s) => s.state.tunnelBusy);
  const [changing, setChanging] = useState(false);

  if (!engine?.relay) {
    return (
      <Card title="Connection service">
        <p className="text-[13px] leading-relaxed text-base-content/60">
          Connect this computer to a service so your phone and Claude can reach it from
          anywhere. The service only forwards traffic — it never stores your notes.
        </p>
        <div className="mt-3">
          <ServicePicker />
        </div>
      </Card>
    );
  }

  const registerBusy = useDesktopStore((s) => s.state.registerBusy);
  // Non-https registration works for testing on this machine's network, but a real
  // phone on another network can't reach it — warn, but never hide the QR.
  const badServiceUrl = !isAllowedServiceUrl(engine.relay.url);

  return (
    <>
      {/* The QR is the whole point of this screen — always shown once registered. */}
      <DesktopPairingCard />
      <Card title="Connection">
        <Row label="Service" value={engine.relay.url} />
        {badServiceUrl && (
          <p className="mt-1 text-[12px] leading-relaxed text-hk-orange-text">
            Not a public <span className="font-mono">https://</span> address — fine for
            testing on this machine&apos;s network, but a phone elsewhere can&apos;t reach it.
            Switch to an https service before sharing.
          </p>
        )}
        <Row label="This device" value={engine.relay.name} />
        <div className="mt-2 flex items-center justify-between gap-4 border-t border-base-200 pt-3">
          <span className="text-[13.5px] text-base-content/60">
            Keep tunnel alive
            <span className="block text-xs text-base-content/35">Required for mobile / remote MCP</span>
          </span>
          <Toggle
            checked={tunnelRunning}
            disabled={tunnelBusy}
            onChange={() => void api.toggleTunnel()}
          />
        </div>
        <div className="mt-3 flex items-center gap-4 border-t border-base-200 pt-3">
          <button
            className="text-[12.5px] font-medium text-base-content/45 transition-colors hover:text-base-content/60"
            onClick={() => setChanging((v) => !v)}
          >
            {changing ? "Hide service list" : "Change service…"}
          </button>
          <button
            className="text-[12.5px] font-medium text-base-content/45 transition-colors hover:text-hk-orange-text disabled:opacity-50"
            disabled={registerBusy}
            onClick={() => void api.disconnectService()}
          >
            Disconnect
          </button>
        </div>
        {changing && (
          <div className="mt-3">
            <ServicePicker onSelected={() => setChanging(false)} />
            <p className="mt-2 text-[11.5px] leading-relaxed text-base-content/35">
              Switching services re-registers this computer — devices paired through the old
              service will need to pair again.
            </p>
          </div>
        )}
      </Card>
      <DesktopPairedDevicesCard />
    </>
  );
}

/**
 * This machine's own connection service (default OFF, deliberately decoupled from
 * the connection card): a phone can talk straight to this computer — zero middlemen —
 * once the machine is publicly reachable over HTTPS (docs "Desktop service picker").
 */
function LocalServiceCard() {
  const api = useDesktopStoreApi();
  const localRelay = useDesktopStore((s) => s.state.localRelay);
  const busy = useDesktopStore((s) => s.state.localRelayBusy);
  const [domainDraft, setDomainDraft] = useState("");

  useEffect(() => {
    void api.refreshLocalRelay();
  }, [api]);

  const running = localRelay?.running ?? false;

  return (
    <Card title="Service on this machine">
      <div className="flex items-center justify-between gap-4">
        <span className="text-[13.5px] text-base-content/60">
          Run a connection service here
          <span className="block text-xs text-base-content/35">
            Phones connect straight to this computer — no third party
          </span>
        </span>
        <Toggle checked={running} disabled={busy} onChange={() => void api.toggleLocalRelay()} />
      </div>
      {running && (
        <div className="mt-3 border-t border-base-200 pt-3">
          <p className="text-[12.5px] leading-relaxed text-base-content/60">
            The service is running on port 8787. To use it, this machine needs a public{" "}
            <span className="font-mono text-[11.5px]">https://</span> domain pointing at it
            (reverse proxy or a Cloudflare-style tunnel — your setup). Then add that domain
            here; auto-select will prefer it.
          </p>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!domainDraft.trim()) return;
              api.addService(domainDraft, true);
              setDomainDraft("");
            }}
          >
            <input
              className={addInputCls}
              placeholder="https://home.example.com"
              value={domainDraft}
              onChange={(e) => setDomainDraft(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
            />
            <button
              type="submit"
              className="shrink-0 rounded-xl border border-base-300 px-3 py-2 text-[13px] font-semibold text-base-content/60 transition-colors hover:bg-base-200 disabled:opacity-50"
              disabled={!domainDraft.trim()}
            >
              Add as service
            </button>
          </form>
        </div>
      )}
    </Card>
  );
}

function DesktopRemote() {
  const api = useDesktopStoreApi();

  useEffect(() => {
    void api.refreshEngine();
  }, [api]);

  return (
    <>
      <ServiceCard />
      <LocalServiceCard />
    </>
  );
}

/**
 * Web binding of the pairing card (docs "Paired-device equivalence"): mints the
 * code at the relay with this device's own clientToken — a paired phone/browser
 * can invite the next device without touching the home computer.
 */
function WebPairingCard() {
  const api = useKbStoreApi();
  const minted = useKbStore((s) => s.state.mintedPair);
  const busy = useKbStore((s) => s.state.mintBusy);
  const error = useKbStore((s) => s.state.mintError);
  const conn = getConnection();
  if (!conn) return null;
  return (
    <PairingCard
      pair={minted ? { ...minted, relayUrl: conn.relayUrl } : null}
      busy={busy}
      error={error}
      onGenerate={() => void api.newPairCode()}
    />
  );
}

/** Web binding: grants via this device's own clientToken; self-revoke = disconnect. */
function WebPairedDevicesCard() {
  const api = useKbStoreApi();
  const grants = useKbStore((s) => s.state.grants);
  const loaded = useKbStore((s) => s.state.grantsLoaded);
  const error = useKbStore((s) => s.state.grantsError);
  const revokingId = useKbStore((s) => s.state.revokingGrantId);

  useEffect(() => {
    void api.loadGrants();
  }, [api]);

  return (
    <PairedDevicesCard
      grants={grants}
      loaded={loaded}
      error={error}
      revokingId={revokingId}
      onRevoke={(id) => void api.revokeDevice(id)}
    />
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
        {conn && <Row label="Service" value={conn.relayUrl} />}
        <div className="mt-2 flex items-center gap-2 border-t border-base-200 pt-3 text-[13px] text-base-content/60">
          <span
            className={
              connState === "online"
                ? "text-success"
                : connState === "connecting"
                  ? "text-warning"
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

      {/* Any paired device can invite + manage devices (docs "Paired-device equivalence"). */}
      <WebPairingCard />
      <WebPairedDevicesCard />

      <Card>
        <p className="text-[13px] leading-relaxed text-base-content/60">
          Disconnecting removes this device&apos;s access token. You can pair again anytime
          with a fresh code from your home computer — or from any other paired device.
        </p>
        {confirming ? (
          <div className="mt-3 flex gap-2">
            <button
              className="flex-1 rounded-xl border border-base-300 px-4 py-2.5 text-[14px] font-semibold text-base-content/60 transition-colors hover:bg-base-200"
              onClick={() => setConfirming(false)}
            >
              Keep connected
            </button>
            <button
              className="flex-1 rounded-xl bg-primary px-4 py-2.5 text-[14px] font-semibold text-primary-content transition-colors hover:bg-primary/90"
              onClick={() => api.unpair()}
            >
              Disconnect
            </button>
          </div>
        ) : (
          <button
            className="mt-3 w-full btn btn-soft btn-outline"
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
          <span className="text-base-content/45">
            <IconPhoneSignal size={18} strokeWidth={1.5} />
          </span>
          <h1 className="text-[21px] font-bold tracking-tight text-base-content">Remote</h1>
        </div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-base-content/60">
          Connect your phone or Claude to this home. The connection service only forwards
          traffic — it never stores your notes.
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
