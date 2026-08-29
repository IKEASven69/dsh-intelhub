/**
 * i18next initialization for hippo web.
 *
 * Detection order: localStorage key 'hippo-lang' → browser language → 'en'.
 * The chosen locale is persisted so a user's language choice survives reloads.
 * All UI strings live in zh.json / en.json; pages consume them via the
 * useTranslation() hook. Memory-type labels (fact/decision/lesson/preference)
 * are translated through the `type.*` keys so they switch with the locale too.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from './en.json';
import zh from './zh.json';

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      zh: { translation: zh },
    },
    fallbackLng: 'en',
    // Treat both 'zh' and 'zh-CN' / 'zh-Hans' as the zh bundle.
    supportedLngs: ['en', 'zh'],
    interpolation: {
      // React already escapes by default; leave interpolation values raw so
      // HTML in translation strings (like <b>) can render via Trans.
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'hippo-lang',
      caches: ['localStorage'],
    },
    // Surface missing keys during development so nothing slips through.
    saveMissing: import.meta.env.DEV,
    missingKeyHandler: import.meta.env.DEV
      ? (_lngs, _ns, key) => console.warn(`[i18n] missing key: ${key}`)
      : undefined,
  });

export default i18n;
