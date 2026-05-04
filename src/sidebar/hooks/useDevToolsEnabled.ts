import { useEffect, useState } from 'react';

/**
 * Whether the DEV test panel should render. Sources, in priority order:
 *
 * 1. `import.meta.env.DEV` — automatic in Vite dev server (`pnpm dev`).
 *    Production builds (`pnpm build`) inline `false` at build time.
 * 2. `chrome.storage.local['devTools'] === true` — manual opt-in persisted
 *    across sidepanel opens. Flipped from the Config page checkbox.
 *
 * The storage key is watched live so the panel appears/disappears without a
 * reload when the user toggles the Config checkbox.
 */
export function useDevToolsEnabled(): boolean {
  const [storageOn, setStorageOn] = useState(false);

  useEffect(() => {
    let alive = true;
    chrome.storage.local
      .get(['devTools'])
      .then((r) => {
        if (alive) setStorageOn(!!r.devTools);
      })
      .catch(() => {});
    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName,
    ) => {
      if (area !== 'local' || !('devTools' in changes)) return;
      setStorageOn(!!changes.devTools?.newValue);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, []);

  return import.meta.env.DEV || storageOn;
}
