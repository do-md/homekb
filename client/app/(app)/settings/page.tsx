"use client";

import { isDesktop } from "@/lib/client/desktop";
import { SettingsView } from "@/features/desktop/components/settings";
import { WebSettingsView } from "@/features/kb/components/settings-web";

/**
 * /settings — all platforms (docs "Settings over RPC"). Desktop renders the
 * full surface (engine/updates/rebuild + AI endpoints via Tauri commands);
 * the web renders the remote subset (AI endpoints + home paths over
 * `kb.configGet`/`kb.configSetAi`). Mode is a runtime constant per session,
 * so the branch never flips after mount.
 */
export default function SettingsPage() {
  return isDesktop() ? <SettingsView /> : <WebSettingsView />;
}
