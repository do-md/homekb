/**
 * i18next singleton — initialized synchronously with inline resources so the
 * first render (SSR/static export included) already has the English strings.
 *
 * React components consume it via `useTranslation()` (react-i18next);
 * non-React code (stores, libs) imports this module and calls `i18n.t(...)`.
 */

import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { DEFAULT_LOCALE } from "./config";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import zh from "./locales/zh.json";

void i18next.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    zh: { translation: zh },
    ja: { translation: ja },
  },
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  interpolation: { escapeValue: false }, // React already escapes
  returnEmptyString: false,
});

export default i18next;
