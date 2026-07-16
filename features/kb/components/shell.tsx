"use client";

/**
 * App shell (top pill nav + a New-note action on the right edge).
 *
 * Header layout: Search / Status / Remote tabs on the left; "New note" sits alone
 * on the far right because its surface is special (focused compose mode renders
 * its own header, no pill nav). The connection state is not a standalone header
 * widget anymore — it rides as a small dot badge on the Remote tab icon, and the
 * Remote page itself shows the full connection details.
 *
 * Mounted once from app/(app)/layout.tsx and persists across tab navigation, so
 * the zenith stores keep their state while Next.js swaps the page below. The URL
 * is the single source of truth for *which surface* is shown: tabs are path
 * routes, dynamic overlays are hash params (see lib/client/hash-route.ts).
 *
 * PWA layout follows the known-good recipe (KB: iOS standalone pitfalls):
 * the shell is `fixed inset-0 overflow-hidden` (document never scrolls; scrolling
 * happens only inside views), each edge panel pads its own safe area with its own
 * background, and html/body are never locked to height:100%.
 */

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { isDesktop } from "@/lib/client/desktop";
import { closeHashOverlay, getHashParam } from "@/lib/client/hash-route";
import { BootScreen } from "@/features/desktop/components/boot-screen";
import {
  DesktopStoreProvider,
  useDesktopStore,
  useDesktopStoreApi,
} from "@/features/desktop/store/desktop-store";
import type { ConnState } from "../type";
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

/** Full connection indicator (dot + label) — used by focused surfaces that have no Remote tab (compose header). */
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

/**
 * Tiny connection badge riding the Remote tab icon's top-right corner — the
 * quiet replacement for the old always-on header indicator. Full details live
 * on the Remote page itself.
 */
function ConnBadge() {
  const connState = useKbStore((s) => s.connState);
  const bg: Record<ConnState, string> = {
    online: "bg-hk-green",
    connecting: "bg-hk-amber animate-pulse",
    offline: "bg-hk-orange",
  };
  return (
    <span
      className={`absolute -right-[3px] -top-[3px] h-[7px] w-[7px] rounded-full ring-2 ring-hk-bg ${bg[connState]}`}
      aria-hidden
    />
  );
}

const NAV: { href: string; label: string; icon: typeof IconSearch }[] = [
  { href: "/search", label: "Search", icon: IconSearch },
  { href: "/status", label: "Status", icon: IconActivity },
  { href: "/remote", label: "Remote", icon: IconPhoneSignal },
  { href: "/settings", label: "Settings", icon: IconSliders },
];

/** Which nav tab a path highlights (#doc belongs to Search; /new renders its own header). */
function activeTab(pathname: string): string {
  const item = NAV.find((n) => pathname === n.href || pathname.startsWith(`${n.href}/`));
  return item?.href ?? "/search";
}

function Header() {
  const api = useKbStoreApi();
  const router = useRouter();
  const pathname = usePathname();
  const desktop = useKbStore((s) => s.state.desktop);
  const active = activeTab(pathname);

  const items = NAV.filter((n) => (desktop ? true : n.href !== "/settings"));

  const goTab = (href: string) => {
    if (href === active) {
      // Re-tapping the active Search tab: close the reader overlay first,
      // then reset to the entry screen (matches the old clearSearch behavior).
      if (href === "/search") {
        if (getHashParam("doc")) closeHashOverlay();
        else api.clearSearch();
      }
      return;
    }
    router.push(href);
  };

  const goCompose = () => {
    // Entering compose resumes the in-progress buffer (clears stale banners).
    api.composeResume();
    router.push("/new");
  };

  return (
    <header className="bg-hk-bg pt-safe-top border-b border-hk-hairline">
      <div className="mx-auto flex h-12 max-w-3xl items-center gap-1 px-3">
        <nav className="flex items-center gap-0.5" aria-label="Main">
          {items.map(({ href, label, icon: Icon }) => {
            const isActive = active === href;
            return (
              <button
                key={href}
                onClick={() => goTab(href)}
                aria-current={isActive ? "page" : undefined}
                className={
                  isActive
                    ? "flex items-center gap-1.5 rounded-[20px] bg-hk-pill px-3 py-1.5 text-[13px] font-semibold text-hk-heading"
                    : "flex items-center rounded-[20px] p-2 text-hk-weak transition-colors hover:text-hk-text-2"
                }
                title={label}
              >
                <span className="relative flex">
                  <Icon size={16} strokeWidth={1.7} />
                  {href === "/remote" && <ConnBadge />}
                </span>
                {isActive && <span>{label}</span>}
              </button>
            );
          })}
        </nav>
        {/* New note lives apart from the tabs: its surface is a focused mode with its own header. */}
        <button
          onClick={goCompose}
          className="ml-auto flex shrink-0 items-center gap-1.5 rounded-full border border-hk-hairline px-2.5 py-1.5 text-[12.5px] font-medium text-hk-text-2 transition-colors hover:bg-hk-card"
          title="New note"
        >
          <IconPlus size={15} strokeWidth={1.8} />
          <span className="hidden min-[420px]:inline">New note</span>
        </button>
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

function Chrome({ children }: { children: React.ReactNode }) {
  const api = useKbStoreApi();
  const pathname = usePathname();
  const paired = useKbStore((s) => s.state.paired);

  useEffect(() => {
    if (!paired) return;
    void api.bootLoads();
    const t = setInterval(() => void api.refreshHealth(), 30_000);
    return () => clearInterval(t);
  }, [paired, api]);

  if (!paired) return <PairScreen />;

  // Focused modes render their own header (design 5a/5b: no pill nav while composing).
  const focused = pathname === "/new" || pathname.startsWith("/new/");

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden">
      {!focused && <Header />}
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
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

export function Shell({ children }: { children: React.ReactNode }) {
  // Runtime mode detection (the shell is loaded ssr:false, client-only; constant within a session)
  if (isDesktop()) {
    return (
      <DesktopStoreProvider>
        <KbStoreProvider>
          <DesktopGate>
            <Chrome>{children}</Chrome>
          </DesktopGate>
        </KbStoreProvider>
      </DesktopStoreProvider>
    );
  }
  return (
    <KbStoreProvider>
      <Chrome>{children}</Chrome>
    </KbStoreProvider>
  );
}
