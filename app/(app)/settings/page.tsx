"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isDesktop } from "@/lib/client/desktop";
import { SettingsView } from "@/features/desktop/components/settings";

/**
 * /settings — desktop-only surface (engine/AI-endpoint config). The web build
 * has no settings tab; a direct visit bounces to /search instead of crashing
 * on the missing desktop store.
 */
export default function SettingsPage() {
  const router = useRouter();
  const desktop = isDesktop();

  useEffect(() => {
    if (!desktop) router.replace("/search");
  }, [desktop, router]);

  if (!desktop) return null;
  return <SettingsView />;
}
