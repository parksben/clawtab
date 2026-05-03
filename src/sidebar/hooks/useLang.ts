import { useEffect, useState } from 'react';
import type { Lang } from '../i18n';

/** Loads the persisted language preference and mirrors updates to storage. */
export function useLang(): [Lang, (lang: Lang) => void] {
  const [lang, setLangState] = useState<Lang>('en');

  useEffect(() => {
    chrome.storage.local
      .get('lang')
      .then((r) => {
        const v = (r as { lang?: Lang }).lang;
        if (v === 'en' || v === 'zh') setLangState(v);
      })
      .catch(() => {});
    const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !changes.lang) return;
      const v = changes.lang.newValue as Lang | undefined;
      if (v === 'en' || v === 'zh') setLangState(v);
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, []);

  const setLang = (v: Lang) => {
    setLangState(v);
    chrome.storage.local.set({ lang: v }).catch(() => {});
  };
  return [lang, setLang];
}
