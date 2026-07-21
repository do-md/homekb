/**
 * Locale configuration — mirrors the trilingual README set (en / zh / ja).
 *
 * The UI follows the browser/OS language only: no in-app switcher, no
 * persistence (same policy as the system light/dark theme). SSR and static
 * export always render DEFAULT_LOCALE; the client switches after mount.
 */

export const LOCALES = ["en", "zh", "ja"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** Map a BCP-47 tag to a supported locale, or null when unsupported. */
export function normalizeLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const lower = tag.toLowerCase();
  if (lower.startsWith("zh")) return "zh";
  if (lower.startsWith("ja")) return "ja";
  if (lower.startsWith("en")) return "en";
  return null;
}

/** Resolve the preferred locale from the browser, falling back to English. */
export function resolveInitialLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  const langs =
    typeof navigator === "undefined"
      ? []
      : navigator.languages?.length
        ? navigator.languages
        : [navigator.language];
  for (const raw of langs) {
    const hit = normalizeLocale(raw);
    if (hit) return hit;
  }
  return DEFAULT_LOCALE;
}
