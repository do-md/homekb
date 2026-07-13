"use client";
import { useState } from "react";
import { defaultRelayUrl } from "@/lib/client/connection";
import { useKbStore, useKbStoreApi } from "../store/kb-store";

type PairMode = "relay" | "direct";

export function PairScreen() {
  const api = useKbStoreApi();
  const busy = useKbStore((s) => s.state.pairBusy);
  const error = useKbStore((s) => s.state.pairError);
  const [mode, setMode] = useState<PairMode>("relay");
  const [relayUrl, setRelayUrl] = useState(defaultRelayUrl());
  const [code, setCode] = useState("");
  const [directUrl, setDirectUrl] = useState("");
  const [directToken, setDirectToken] = useState("");

  const relayReady = code.trim().length >= 4 && relayUrl.trim().length > 0;
  const directReady = directUrl.trim().length > 0 && directToken.trim().length > 0;

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <h1 className="text-center text-3xl font-bold">HomeKB</h1>
        <p className="mt-2 text-center text-sm opacity-60">
          Your knowledge base lives on your own computer.
        </p>

        <div role="tablist" className="tabs tabs-box mt-6">
          <button
            role="tab"
            type="button"
            className={`tab flex-1 ${mode === "relay" ? "tab-active" : ""}`}
            onClick={() => setMode("relay")}
          >
            Use a relay
          </button>
          <button
            role="tab"
            type="button"
            className={`tab flex-1 ${mode === "direct" ? "tab-active" : ""}`}
            onClick={() => setMode("direct")}
          >
            Connect directly
          </button>
        </div>

        {mode === "relay" ? (
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (relayReady) void api.pairRelay(relayUrl.trim(), code.trim());
            }}
          >
            <p className="text-xs opacity-50">
              Run <code>homekb pair</code> on your home machine to get a pairing code.
            </p>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="Pairing code, e.g. A7KM2XQ9"
              maxLength={8}
              autoFocus
              className="input input-bordered input-lg w-full text-center font-mono uppercase tracking-widest"
              autoComplete="one-time-code"
            />
            <label className="flex flex-col gap-1">
              <span className="text-xs opacity-50">Relay server</span>
              <input
                value={relayUrl}
                onChange={(e) => setRelayUrl(e.target.value)}
                placeholder="https://relay.example.com"
                className="input input-bordered input-sm w-full font-mono text-xs"
                autoCapitalize="none"
                autoCorrect="off"
              />
            </label>
            {error && <p className="text-error text-center text-sm">{error}</p>}
            <button
              type="submit"
              disabled={busy || !relayReady}
              className="btn btn-primary btn-lg w-full"
            >
              {busy ? <span className="loading loading-spinner" /> : "Connect"}
            </button>
            <p className="text-center text-xs opacity-40">
              The relay only moves data between you and your computer — nothing is stored on it.
            </p>
          </form>
        ) : (
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (directReady) void api.pairDirect(directUrl.trim(), directToken.trim());
            }}
          >
            <p className="text-xs opacity-50">
              Your computer is reachable at a public address (run{" "}
              <code>homekb serve --host 0.0.0.0</code> on it to get the URL and token).
            </p>
            <input
              value={directUrl}
              onChange={(e) => setDirectUrl(e.target.value)}
              placeholder="https://home.example.com:8765"
              autoFocus
              className="input input-bordered w-full font-mono text-sm"
              autoCapitalize="none"
              autoCorrect="off"
            />
            <input
              value={directToken}
              onChange={(e) => setDirectToken(e.target.value)}
              placeholder="Token, e.g. hkd_…"
              type="password"
              className="input input-bordered w-full font-mono text-sm"
              autoComplete="off"
            />
            {error && <p className="text-error text-center text-sm">{error}</p>}
            <button
              type="submit"
              disabled={busy || !directReady}
              className="btn btn-primary btn-lg w-full"
            >
              {busy ? <span className="loading loading-spinner" /> : "Connect"}
            </button>
            <p className="text-center text-xs opacity-40">
              Direct mode: your browser talks straight to your computer — no relay in between.
            </p>
          </form>
        )}
      </div>
    </main>
  );
}
