"use client";
import { useEffect } from "react";
import { isDesktop } from "@/lib/client/desktop";
import { BootScreen } from "@/features/desktop/components/boot-screen";
import { SettingsView } from "@/features/desktop/components/settings";
import {
  DesktopStoreProvider,
  useDesktopStore,
  useDesktopStoreApi,
} from "@/features/desktop/store/desktop-store";
import type { KbView } from "../type";
import { KbStoreProvider, useKbStore, useKbStoreApi } from "../store/kb-store";
import { PairScreen } from "./pair-screen";
import { NewNoteView } from "./views/new-note";
import { ReaderView } from "./views/reader";
import { RecallView } from "./views/recall";
import { StatusView } from "./views/status";

function Header() {
  const api = useKbStoreApi();
  const view = useKbStore((s) => s.state.view);
  const badge = useKbStore((s) => s.connBadge);
  const desktop = useKbStore((s) => s.state.desktop);

  const items: [KbView, string][] = [
    ["recall", "召回"],
    ["new", "新建"],
    ["status", "状态"],
    ...(desktop ? ([["settings", "设置"]] as [KbView, string][]) : []),
  ];

  return (
    <header className="bg-base-100/90 sticky top-0 z-10 backdrop-blur">
      <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 pt-[env(safe-area-inset-top)] pb-2">
        <button className="text-lg font-bold" onClick={() => api.go("recall")}>
          HomeKB
        </button>
        <span className={`badge badge-sm ${badge.cls}`}>{badge.text}</span>
        <nav className="ml-auto flex gap-1">
          {items.map(([v, label]) => (
            <button
              key={v}
              onClick={() => api.go(v)}
              className={`btn btn-ghost btn-sm ${view === v ? "btn-active" : ""}`}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>
    </header>
  );
}

function Main() {
  const api = useKbStoreApi();
  const paired = useKbStore((s) => s.state.paired);
  const view = useKbStore((s) => s.state.view);
  const notice = useKbStore((s) => s.state.actionNotice);

  useEffect(() => {
    if (!paired) return;
    void api.refreshHealth();
    void api.loadRecent();
    const t = setInterval(() => void api.refreshHealth(), 30_000);
    return () => clearInterval(t);
  }, [paired, api]);

  if (!paired) return <PairScreen />;

  return (
    <div className="min-h-dvh">
      <Header />
      <main className="mx-auto max-w-2xl px-4 pt-2 pb-[calc(env(safe-area-inset-bottom)+2rem)]">
        {view === "recall" && <RecallView />}
        {view === "reader" && <ReaderView />}
        {view === "new" && <NewNoteView />}
        {view === "status" && <StatusView />}
        {view === "settings" && <SettingsView />}
      </main>
      {notice && (
        <div className="toast toast-center toast-bottom z-20">
          <div className="alert alert-info py-2 text-sm">{notice}</div>
        </div>
      )}
    </div>
  );
}

/** 桌面引导闸：检测/安装引擎并拉起 serve 后才进主界面。 */
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
  // 运行时模式检测（页面 ssr:false，仅客户端执行；一次会话内恒定）
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
