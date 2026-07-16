"use client";

import dynamic from "next/dynamic";

// Pure client-side rendering: pairing/connection state lives in localStorage,
// unknown to SSR — the shell (providers + gates + header) loads ssr:false to
// prevent hydration mismatch. It lives in this shared layout so it mounts once
// and the zenith stores persist across tab navigation.
const Shell = dynamic(() => import("@/features/kb/components/shell").then((m) => m.Shell), {
  ssr: false,
  loading: () => (
    <main className="fixed inset-0 flex items-center justify-center">
      <span
        className="hk-spin inline-block h-5 w-5 rounded-full border-2 border-current border-t-transparent text-hk-coral-text"
        aria-label="Loading"
      />
    </main>
  ),
});

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <Shell>{children}</Shell>;
}
