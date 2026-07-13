"use client";
import dynamic from "next/dynamic";

// Pure client-side rendering: pairing state is stored in localStorage, unknown to SSR — disable SSR to prevent hydration mismatch
const Kb = dynamic(() => import("@/features/kb/components/kb").then((m) => m.Kb), {
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

export default function Home() {
  return <Kb />;
}
