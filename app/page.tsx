"use client";
import dynamic from "next/dynamic";

// Pure client-side rendering: pairing state is stored in localStorage, unknown to SSR — disable SSR to prevent hydration mismatch
const Kb = dynamic(() => import("@/features/kb/components/kb").then((m) => m.Kb), {
  ssr: false,
  loading: () => (
    <main className="flex min-h-dvh items-center justify-center">
      <span className="loading loading-spinner" />
    </main>
  ),
});

export default function Home() {
  return <Kb />;
}
