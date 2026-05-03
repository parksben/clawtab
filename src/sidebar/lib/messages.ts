// Thin typed wrapper around chrome.runtime.sendMessage for the sidebar.
// Every caller imports from here so the argument union stays honest.

import type {
  BasicResponse,
  FetchHistoryResponse,
  ListAgentsResponse,
  SidebarToBackgroundMessage,
} from '@/shared/types/messages';
import type { DiagBundle } from '@/shared/types/state';

export async function sendBg<R = BasicResponse>(
  msg: SidebarToBackgroundMessage,
): Promise<R> {
  return (await chrome.runtime.sendMessage(msg)) as R;
}

export const bg = {
  connect: (url: string, token: string, name: string) =>
    sendBg({ type: 'connect', url, token, name }),
  disconnect: () => sendBg({ type: 'disconnect' }),
  getStatus: () => sendBg({ type: 'get_status' }),
  cancel: () => sendBg({ type: 'cancel' }),

  fetchHistory: (sessionKey: string) =>
    sendBg<FetchHistoryResponse>({ type: 'sidebar_fetch_history', sessionKey }),

  ensureAndSend: (sessionKey: string, message: string) =>
    sendBg({ type: 'sidebar_ensure_and_send', sessionKey, message }),

  resetContext: (sessionKey: string) =>
    sendBg({ type: 'sidebar_reset_context', sessionKey }),

  listAgents: () =>
    sendBg<ListAgentsResponse>({ type: 'sidebar_list_agents' }),

  sidebarOpened: () => sendBg({ type: 'sidebar_opened' }),
  sidebarClosed: () => sendBg({ type: 'sidebar_closed' }),

  diagGet: () => sendBg<DiagBundle | { ok: false; error: string }>({ type: 'diag_get' }),
  logClear: () => sendBg({ type: 'log_clear' }),
  logEvent: (
    level: 'info' | 'warn' | 'error' | 'debug',
    msg: string,
    data?: unknown,
  ) =>
    sendBg({
      type: 'log_event',
      level,
      src: 'sidebar',
      msg,
      data,
    }),

  enterPickMode: () => sendBg({ type: 'enter_pick_mode' }),
  exitPickMode: () => sendBg({ type: 'exit_pick_mode' }),
  flashElement: (selector: string) => sendBg({ type: 'flash_element', selector }),
};

export function clog(
  level: 'info' | 'warn' | 'error' | 'debug',
  msg: string,
  data?: unknown,
): void {
  bg.logEvent(level, msg, data).catch(() => {});
  // also mirror to sidepanel devtools for live debugging
  const line = `[sidebar] ${msg}`;
  if (level === 'error') console.error(line, data ?? '');
  else if (level === 'warn') console.warn(line, data ?? '');
  else console.log(line, data ?? '');
}
