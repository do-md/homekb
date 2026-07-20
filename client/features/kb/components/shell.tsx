"use client";

/**
 * App shell (top pill nav + a New-note action on the right edge).
 *
 * Header layout: Search / Status / Remote tabs on the left; "New note" sits alone
 * on the far right because its surface is special (focused compose mode renders
 * its own header, no pill nav). The connection state has no standalone widget
 * anywhere — it rides as a small dot badge on the Remote tab icon, and the
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
import { UpdateBanner } from "@/features/desktop/components/update-banner";
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
  IconShare,
  IconSliders,
} from "./icons";
import { PairScreen } from "./pair-screen";

/**
 * Tiny connection badge riding the Remote tab icon's top-right corner — the
 * quiet replacement for the old always-on header indicator. Full details live
 * on the Remote page itself.
 */
function ConnBadge() {
  const connState = useKbStore((s) => s.connState);
  const bg: Record<ConnState, string> = {
    online: "bg-success",
    connecting: "bg-warning animate-pulse",
    offline: "bg-hk-orange",
  };
  return (
    <span
      className={`absolute -right-[3px] -top-[3px] h-[7px] w-[7px] rounded-full ring-2 ring-base-100 ${bg[connState]}`}
      aria-hidden
    />
  );
}

/**
 * Primary dot on the Settings tab while the engine still lacks a required AI key
 * ([embedding] or [summary]) — the quiet nudge that pairs with the full
 * "Add your AI keys" guide on the Search screen. Desktop only: the Settings tab
 * now renders on all platforms (docs "Settings over RPC"), so the caller gates
 * this badge on desktop mode — the DesktopStore provider it reads only mounts
 * there.
 */
function SettingsBadge() {
  const needsSetup = useDesktopStore((s) => s.aiSetupNeeded);
  if (!needsSetup) return null;
  return (
    <span
      className="absolute -right-[3px] -top-[3px] h-[7px] w-[7px] rounded-full bg-primary ring-2 ring-base-100"
      aria-hidden
    />
  );
}

const NAV: { href: string; label: string; icon: typeof IconSearch }[] = [
  { href: "/search", label: "Search", icon: IconSearch },
  { href: "/shares", label: "Shares", icon: IconShare },
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

  // Settings renders on all platforms now (docs "Settings over RPC").
  const items = NAV;

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
    // "New note" is always a blank canvas — never resurrect a previously
    // opened draft / edited note left in the compose buffer. In-progress work
    // is auto-stashed to the Drafts list on view-switch, so nothing is lost;
    // the user resumes it explicitly from Drafts (`/new#draft=<id>`), not here.
    api.composeNew();
    router.push("/new");
  };

  return (
    <header className="bg-base-100 pt-safe-top">
      <div className="mx-auto flex h-16 max-w-3xl items-center gap-1 px-3">
        <nav className="flex items-center gap-1.5" aria-label="Main">
          {items.map(({ href, label, icon: Icon }) => {
            const isActive = active === href;
            return (
              // Notion-style tabs: inactive ones keep a faint circular backdrop
              // (visibly tappable), the active one widens into a labeled pill.
              // The label is always mounted and collapses via max-width/opacity
              // so the width change animates instead of jumping.
              <button
                key={href}
                onClick={() => goTab(href)}
                aria-current={isActive ? "page" : undefined}
                className={`flex items-center rounded-full py-2 text-[13px] font-semibold transition-[background-color,padding] duration-300 ${
                  isActive
                    ? "bg-base-200 px-3 text-base-content"
                    : "bg-base-200/60 px-3.5 text-base-content/45 hover:bg-base-200 hover:text-base-content/60"
                }`}
                title={label}
              >
                <span className="relative flex">
                  <Icon size={16} strokeWidth={1.7} />
                  {href === "/remote" && <ConnBadge />}
                  {/* Badge reads the DesktopStore — its provider only mounts in desktop mode. */}
                  {href === "/settings" && desktop && <SettingsBadge />}
                </span>
                {/* No fade on the label: full-opacity text is revealed/clipped by the
                    animating width — a fade reads as sluggish color change here. */}
                <span
                  className={`overflow-hidden leading-4 whitespace-nowrap transition-[max-width,margin] duration-300 ${
                    isActive ? "ml-1.5 max-w-[72px]" : "ml-0 max-w-0"
                  }`}
                >
                  {label}
                </span>
              </button>
            );
          })}
        </nav>
        {/* New note lives apart from the tabs: its surface is a focused mode with its own header. */}
        <button
          onClick={goCompose}
          className="ml-auto btn btn-primary btn-sm rounded-full"
          title="New note"
        >
          <IconPlus size={15} strokeWidth={2} />
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
        className="rounded-full border border-base-200 bg-hk-composer px-4 py-2 text-[13px] text-base-content backdrop-blur-md"
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
    // App self-update: silent check on launch + window focus (store rate-limits
    // to 1/h, production builds only). Readiness renders as the in-app banner.
    void api.checkForUpdate();
    const onFocus = () => void api.checkForUpdate();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [api]);

  if (phase !== "ready") return <BootScreen />;
  return (
    <>
      {children}
      <UpdateBanner />
    </>
  );
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
