"use client";

/**
 * App shell (design: 5-tab top pill nav + connection indicator in every header).
 *
 * PWA layout follows the known-good recipe (KB: iOS standalone pitfalls):
 * the shell is `fixed inset-0 overflow-hidden` (document never scrolls; scrolling
 * happens only inside views), each edge panel pads its own safe area with its own
 * background, and html/body are never locked to height:100%.
 */

import { useEffect } from "react";
import { isDesktop } from "@/lib/client/desktop";
import { BootScreen } from "@/features/desktop/components/boot-screen";
import { SettingsView } from "@/features/desktop/components/settings";
import {
  DesktopStoreProvider,
  useDesktopStore,
  useDesktopStoreApi,
} from "@/features/desktop/store/desktop-store";
import type { ConnState, KbView } from "../type";
import { KbStoreProvider, useKbStore, useKbStoreApi } from "../store/kb-store";
import {
  IconActivity,
  IconPhoneSignal,
  IconPlus,
  IconSearch,
  IconSliders,
  Spinner,
  StatusDot,
} from "./icons";
import { PairScreen } from "./pair-screen";
import { DraftsView } from "./views/drafts";
import { NewNoteView } from "./views/new-note";
import { ReaderView } from "./views/reader";
import { RecallView } from "./views/recall";
import { RemoteView } from "./views/remote";
import { StatusView } from "./views/status";

/** Single connection indicator that rides in every header (product-defining). */
export function ConnIndicator() {
  const connState = useKbStore((s) => s.connState);
  const desktop = useKbStore((s) => s.state.desktop);

  const text: Record<ConnState, string> = desktop
    ? { online: "Engine online", connecting: "Starting engine…", offline: "Engine offline" }
    : { online: "Connected to home", connecting: "Connecting to home…", offline: "Home is offline" };
  const color: Record<ConnState, string> = {
    online: "text-hk-green",
    connecting: "text-hk-amber",
    offline: "text-hk-orange",
  };
  const textColor: Record<ConnState, string> = {
    online: "text-hk-weak",
    connecting: "text-hk-amber-text",
    offline: "text-hk-orange-text",
  };

  return (
    <span className={`flex items-center gap-1.5 ${color[connState]}`}>
      <StatusDot />
      {connState === "connecting" && <Spinner size={11} className="opacity-70" />}
      <span className={`hidden text-[12px] font-medium min-[420px]:inline ${textColor[connState]}`}>
        {text[connState]}
      </span>
    </span>
  );
}

const NAV: { view: KbView; label: string; icon: typeof IconSearch }[] = [
  { view: "recall", label: "Search", icon: IconSearch },
  { view: "new", label: "New note", icon: IconPlus },
  { view: "status", label: "Status", icon: IconActivity },
  { view: "remote", label: "Remote", icon: IconPhoneSignal },
  { view: "settings", label: "Settings", icon: IconSliders },
];

/** Which nav tab a view highlights (reader belongs to Search, drafts to New note). */
function activeTab(view: KbView): KbView {
  if (view === "reader") return "recall";
  if (view === "drafts") return "new";
  return view;
}

function Header() {
  const api = useKbStoreApi();
  const view = useKbStore((s) => s.state.view);
  const desktop = useKbStore((s) => s.state.desktop);
  const active = activeTab(view);

  const items = NAV.filter((n) => (desktop ? true : n.view !== "settings"));

  const goTab = (v: KbView) => {
    if (v === "new") api.composeResume();
    else if (v === "recall" && view === "recall") api.clearSearch();
    else api.go(v);
  };

  return (
    <header className="bg-hk-bg pt-safe-top border-b border-hk-hairline">
      <div className="mx-auto flex h-12 max-w-3xl items-center gap-1 px-3">
        <nav className="flex items-center gap-0.5" aria-label="Main">
          {items.map(({ view: v, label, icon: Icon }) => {
            const isActive = active === v;
            return (
              <button
                key={v}
                onClick={() => goTab(v)}
                aria-current={isActive ? "page" : undefined}
                className={
                  isActive
                    ? "flex items-center gap-1.5 rounded-[20px] bg-hk-pill px-3 py-1.5 text-[13px] font-semibold text-hk-heading"
                    : "flex items-center rounded-[20px] p-2 text-hk-weak transition-colors hover:text-hk-text-2"
                }
                title={label}
              >
                <Icon size={16} strokeWidth={1.7} />
                {isActive && <span>{label}</span>}
              </button>
            );
          })}
        </nav>
        <span className="ml-auto shrink-0">
          <ConnIndicator />
        </span>
      </div>
    </header>
  );
}

function Notice() {
  const notice = useKbStore((s) => s.state.actionNotice);
  if (!notice) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-24 z-30 flex justify-center px-4">
      <div
        className="rounded-full border border-hk-hairline bg-hk-composer px-4 py-2 text-[13px] text-hk-text backdrop-blur-md"
        style={{ boxShadow: "0 4px 16px rgba(0,0,0,0.25)" }}
      >
        {notice}
      </div>
    </div>
  );
}

function Main() {
  const api = useKbStoreApi();
  const paired = useKbStore((s) => s.state.paired);
  const view = useKbStore((s) => s.state.view);

  useEffect(() => {
    if (!paired) return;
    void api.bootLoads();
    const t = setInterval(() => void api.refreshHealth(), 30_000);
    return () => clearInterval(t);
  }, [paired, api]);

  if (!paired) return <PairScreen />;

  // Focused modes render their own header (design 5a/5b: no pill nav while composing).
  const focused = view === "new" || view === "drafts";

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden">
      {!focused && <Header />}
      <main className="flex min-h-0 flex-1 flex-col">
        {view === "recall" && <RecallView />}
        {view === "reader" && <ReaderView />}
        {view === "new" && <NewNoteView />}
        {view === "drafts" && <DraftsView />}
        {view === "status" && <StatusView />}
        {view === "remote" && <RemoteView />}
        {view === "settings" && <SettingsView />}
      </main>
      <Notice />
    </div>
  );
}

/** Desktop gate: detects/installs engine and starts serve before showing the main UI. */
function DesktopGate({ children }: { children: React.ReactNode }) {
  const api = useDesktopStoreApi();
  const phase = useDesktopStore((s) => s.state.phase);

  useEffect(() => {
    void api.bootstrap();
  }, [api]);

  if (phase !== "ready") return <BootScreen />;
  return <>{children}</>;
}

export function Kb() {
  // Runtime mode detection (page is ssr:false, client-only; constant within a session)
  if (isDesktop()) {
    return (
      <DesktopStoreProvider>
        <KbStoreProvider>
          <DesktopGate>
            <Main />
          </DesktopGate>
        </KbStoreProvider>
      </DesktopStoreProvider>
    );
  }
  return (
    <KbStoreProvider>
      <Main />
    </KbStoreProvider>
  );
}
