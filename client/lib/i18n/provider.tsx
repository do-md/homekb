"use client";

import { useEffect } from "react";
import { I18nextProvider } from "react-i18next";
import { invoke, isDesktop } from "@/lib/client/desktop";
import { resolveInitialLocale, type Locale } from "./config";
import i18n from "./index";

/**
 * Keep the native (Tauri) side informed of the resolved locale.
 *
 * The desktop shell currently has nothing user-visible to localize (no native
 * menu, no system dialogs by design), but the channel is kept so future native
 * surfaces pick the language up without a protocol change. Failures are
 * ignored — older desktop builds simply don't have the command.
 */
function syncNativeLocale(locale: Locale): void {
  if (!isDesktop()) return;
  invoke("set_locale", { locale }).catch(() => {});
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const target = resolveInitialLocale();
    if (i18n.language !== target) {
      void i18n.changeLanguage(target);
    }
    document.documentElement.lang = target;
    syncNativeLocale(target);
  }, []);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
