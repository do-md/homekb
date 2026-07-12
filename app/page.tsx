"use client";
import dynamic from "next/dynamic";

// 纯客户端渲染：配对态存 localStorage，SSR 无法得知，禁 SSR 防 hydration 抖动
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
