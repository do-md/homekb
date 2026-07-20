"use client";

/**
 * App shell (top pill nav + a New-note action on the right edge).
 *
 * Header layout: Search / Shares / Remote are first-class pill tabs on every width;
 * the two low-frequency destinations (Status, Settings) trail them and collapse into
 * a "More" dropdown on phones (< sm), staying as full tabs on wider screens. "New note"
 * sits alone on the far right because its surface is special (focused compose mode
 * renders its own header, no pill nav). The connection state has no standalone widget
 * anywhere — it rides as a small dot badge on the Remote tab icon, and the Remote page
 * itself shows the full connection details.
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
  IconGear,
  IconLink,
  IconMore,
  IconPhoneSignal,
  IconPlus,
  IconSearch,
} from "./icons";
import { GlobalMdDrop } from "./global-md-drop";
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

type NavItem = { href: string; label: string; icon: typeof IconSearch };

const NAV: NavItem[] = [
  { href: "/search", label: "Search", icon: IconSearch },
  { href: "/shares", label: "Shares", icon: IconLink },
  { href: "/remote", label: "Remote", icon: IconPhoneSignal },
  { href: "/status", label: "Status", icon: IconActivity },
  { href: "/settings", label: "Settings", icon: IconGear },
];

// The two lowest-frequency destinations collapse into a "More" dropdown on phones.
// They live at the tail of NAV so the collapse is a clean tail-cut; Search / Shares /
// Remote stay first-class tabs on every width.
const OVERFLOW = new Set(["/status", "/settings"]);
const PRIMARY_NAV = NAV.filter((n) => !OVERFLOW.has(n.href));
const OVERFLOW_NAV = NAV.filter((n) => OVERFLOW.has(n.href));

/** Which nav tab a path highlights (#doc belongs to Search; /new renders its own header). */
function activeTab(pathname: string): string {
  const item = NAV.find((n) => pathname === n.href || pathname.startsWith(`${n.href}/`));
  return item?.href ?? "/search";
}

/** Shared Notion-style pill styling for both real tabs and the "More" trigger. */
function pillClass(active: boolean): string {
  return `flex items-center rounded-full py-2 text-[13px] font-semibold transition-[background-color,padding] duration-300 ${
    active
      ? "bg-base-200 px-3 text-base-content"
      : "bg-base-200/60 px-3.5 text-base-content/45 hover:bg-base-200 hover:text-base-content/60"
  }`;
}

/**
 * One pill tab. The label is always mounted and collapses via max-width/opacity so the
 * width change animates instead of jumping (deci-a3542e). `desktop` gates the Settings
 * badge, whose store only mounts in desktop mode.
 */
function NavTab({
  item,
  active,
  desktop,
  onSelect,
}: {
  item: NavItem;
  active: boolean;
  desktop: boolean;
  onSelect: (href: string) => void;
}) {
  const { href, label, icon: Icon } = item;
  return (
    <button
      onClick={() => onSelect(href)}
      aria-current={active ? "page" : undefined}
      className={pillClass(active)}
      title={label}
    >
      <span className="relative flex">
        <Icon size={16} strokeWidth={1.7} />
        {href === "/remote" && <ConnBadge />}
        {href === "/settings" && desktop && <SettingsBadge />}
      </span>
      <span
        className={`overflow-hidden leading-4 whitespace-nowrap transition-[max-width,margin] duration-300 ${
          active ? "ml-1.5 max-w-[72px]" : "ml-0 max-w-0"
        }`}
      >
        {label}
      </span>
    </button>
  );
}

/**
 * Phones-only overflow menu (< sm) holding Status + Settings. The trigger morphs into the
 * active child's labeled pill when you're on one of those routes, so the active-state
 * pattern stays consistent with the real tabs; otherwise it shows a quiet "more" ellipsis.
 * The Settings setup nudge is surfaced on the trigger so it isn't lost while collapsed.
 */
function OverflowMenu({
  active,
  desktop,
  onSelect,
}: {
  active: string;
  desktop: boolean;
  onSelect: (href: string) => void;
}) {
  const current = OVERFLOW_NAV.find((n) => n.href === active);
  const CurrentIcon = current?.icon;
  const select = (href: string) => {
    onSelect(href);
    // Close the focus-driven daisyUI dropdown after choosing.
    if (typeof document !== "undefined") (document.activeElement as HTMLElement | null)?.blur();
  };
  return (
    <div className="dropdown dropdown-end sm:hidden">
      <div
        tabIndex={0}
        role="button"
        aria-haspopup="menu"
        aria-label={current ? current.label : "More"}
        className={pillClass(Boolean(current))}
        title={current ? current.label : "More"}
      >
        <span className="relative flex">
          {CurrentIcon ? (
            <CurrentIcon size={16} strokeWidth={1.7} />
          ) : (
            <IconMore size={16} strokeWidth={1.7} />
          )}
          {desktop && !current && <SettingsBadge />}
        </span>
        <span
          className={`overflow-hidden leading-4 whitespace-nowrap transition-[max-width,margin] duration-300 ${
            current ? "ml-1.5 max-w-[72px]" : "ml-0 max-w-0"
          }`}
        >
          {current?.label}
        </span>
      </div>
      <ul
        tabIndex={0}
        className="dropdown-content menu z-50 mt-2 w-44 rounded-2xl bg-base-100 p-1.5 shadow-lg ring-1 ring-base-200"
      >
        {OVERFLOW_NAV.map(({ href, label, icon: Icon }) => {
          const isActive = active === href;
          return (
            <li key={href}>
              <button
                onClick={() => select(href)}
                aria-current={isActive ? "page" : undefined}
                className={isActive ? "bg-base-200 font-semibold" : "font-medium"}
              >
                <span className="relative flex">
                  <Icon size={16} strokeWidth={1.7} />
                  {href === "/settings" && desktop && <SettingsBadge />}
                </span>
                <span className="text-[13px]">{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Header() {
  const api = useKbStoreApi();
  const router = useRouter();
  const pathname = usePathname();
  const desktop = useKbStore((s) => s.state.desktop);
  const active = activeTab(pathname);

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
          {/* Notion-style tabs (deci-a3542e): inactive ones keep a faint circular backdrop
              (visibly tappable), the active one widens into a labeled pill. */}
          {PRIMARY_NAV.map((item) => (
            <NavTab
              key={item.href}
              item={item}
              active={active === item.href}
              desktop={desktop}
              onSelect={goTab}
            />
          ))}
          {/* Status + Settings: full tabs on wider screens, collapsed into "More" on phones. */}
          <div className="hidden items-center gap-1.5 sm:flex">
            {OVERFLOW_NAV.map((item) => (
              <NavTab
                key={item.href}
                item={item}
                active={active === item.href}
                desktop={desktop}
                onSelect={goTab}
              />
            ))}
          </div>
          <OverflowMenu active={active} desktop={desktop} onSelect={goTab} />
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
      {/* Global .md drag-import — mounted once here so every route is covered
          (docs "Markdown file import"); paired-only, an import needs the home. */}
      <GlobalMdDrop />
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
