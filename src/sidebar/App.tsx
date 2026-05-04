import { useCallback, useEffect, useReducer, useRef } from 'react';
import type {
  BackgroundBroadcast,
  ElementPickedBroadcast,
  StatusUpdateBroadcast,
  TabActivatedBroadcast,
} from '@/shared/types/messages';
import { ConfigPage } from './components/ConfigPage';
import { ChatPage } from './components/ChatPage';
import { Toast } from './components/Toast';
import { useLang } from './hooks/useLang';
import { t } from './i18n';
import { bg, clog } from './lib/messages';
import { msgKey } from './lib/message-utils';
import {
  initialState,
  reducer,
  selectVisibleMessages,
  type Attachment,
} from './state/reducer';

export function App() {
  const [lang, setLang] = useLang();
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const pollTimerRef = useRef<number | null>(null);
  const waitingTimerRef = useRef<number | null>(null);
  const inputRefSaver = useRef<() => string>(() => '');
  const hiddenLoadedForChannel = useRef<string | null>(null);

  const sessionKey = () => `agent:${state.selectedAgent}:clawtab-${state.channelName}`;
  const hiddenStorageKey = (sk: string) => `hidden_${sk}`;

  // ── bootstrap ──
  useEffect(() => {
    (async () => {
      try {
        const s = (await bg.getStatus()) as unknown as StatusUpdateBroadcast;
        if (s && (s as { ok?: boolean }).ok !== false) {
          dispatch({
            type: 'STATUS_UPDATE',
            snapshot: {
              wsConnected: s.wsConnected,
              pairingPending: s.pairingPending,
              reconnecting: s.reconnecting,
              gaveUp: (s as { gaveUp?: boolean }).gaveUp,
              deviceId: s.deviceId,
              browserId: s.browserId,
              wsUrl: s.wsUrl,
              tabCount: s.tabCount,
              lastCmd: s.lastCmd,
              loop: s.loop,
            },
          });
        }
      } catch (e) {
        clog('warn', 'initial get_status failed', { error: (e as Error).message });
      }

      // Agent list
      try {
        const r = await bg.listAgents();
        if (r.ok && r.agents?.length) {
          const names = r.agents.map((a) =>
            typeof a === 'string' ? a : a.id || String(a),
          );
          dispatch({ type: 'SET_AGENTS', agents: names });
        }
      } catch {
        /* keep defaults */
      }

      // Active tab (for tab-draft save/restore)
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          dispatch({
            type: 'TAB_ACTIVATED',
            tabId: tab.id,
            currentDraft: { input: '', attachments: [] },
          });
        }
      } catch {
        /* ignore */
      }

      bg.sidebarOpened().catch(() => {});
    })();

    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        bg.sidebarClosed().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // ── runtime message subscription ──
  useEffect(() => {
    const handler = (incoming: BackgroundBroadcast) => {
      switch (incoming.type) {
        case 'status_update': {
          dispatch({ type: 'STATUS_UPDATE', snapshot: incoming });
          return;
        }
        case 'element_picked': {
          const pick = (incoming as ElementPickedBroadcast).element;
          dispatch({ type: 'ELEMENT_PICKED', element: pick });
          return;
        }
        case 'pick_mode_exited': {
          dispatch({ type: 'PICK_MODE_OFF' });
          return;
        }
        case 'tab_activated': {
          const tabId = (incoming as TabActivatedBroadcast).tabId;
          dispatch({
            type: 'TAB_ACTIVATED',
            tabId,
            currentDraft: { input: inputRefSaver.current(), attachments: state.attachments },
          });
          return;
        }
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [state.attachments]);

  // ── load hiddenMsgKeys from storage when channel becomes known ──
  // Must complete before the polling effect lets HYDRATE_HISTORY through —
  // otherwise a fast first tick re-hydrates freshly cleared messages.
  useEffect(() => {
    if (!state.wsConnected || !state.channelName) return;
    const sk = sessionKey();
    if (hiddenLoadedForChannel.current === sk) return;
    hiddenLoadedForChannel.current = sk;
    (async () => {
      try {
        const stored = (await chrome.storage.local.get(hiddenStorageKey(sk))) as Record<
          string,
          unknown
        >;
        const raw = stored[hiddenStorageKey(sk)];
        const keys = Array.isArray(raw) ? (raw as string[]) : [];
        dispatch({ type: 'HYDRATE_HIDDEN_KEYS', keys });
      } catch (e) {
        clog('warn', 'hiddenKeys load failed', { error: (e as Error).message });
        dispatch({ type: 'HYDRATE_HIDDEN_KEYS', keys: [] });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.wsConnected, state.channelName, state.selectedAgent]);

  // ── persist hiddenMsgKeys on every change (debounced ~250ms) ──
  useEffect(() => {
    if (!state.hiddenKeysHydrated || !state.channelName) return;
    const sk = sessionKey();
    const handle = window.setTimeout(() => {
      const arr = Array.from(state.hiddenMsgKeys);
      chrome.storage.local.set({ [hiddenStorageKey(sk)]: arr }).catch(() => {});
    }, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.hiddenMsgKeys,
    state.hiddenKeysHydrated,
    state.channelName,
    state.selectedAgent,
  ]);

  // ── polling loop ──
  const runFetchHistory = useCallback(async () => {
    if (!state.wsConnected || !state.channelName) return;
    try {
      const res = await bg.fetchHistory(sessionKey());
      if (!res.ok) return;
      if (!res.messages?.length) return;
      dispatch({ type: 'HYDRATE_HISTORY', fetched: res.messages });
    } catch (e) {
      clog('warn', 'fetchHistory failed', { error: (e as Error).message });
    }
    // intentionally not dependent on sessionKey — reading state at call time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.wsConnected, state.channelName, state.selectedAgent]);

  useEffect(() => {
    // Start / stop polling based on connection AND blocklist hydration.
    // Without the hydration gate, a fast first tick would re-surface messages
    // the user just cleared (storage hasn't loaded yet).
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (!state.wsConnected || !state.channelName) return;
    if (!state.hiddenKeysHydrated) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await runFetchHistory();
      if (cancelled) return;
      pollTimerRef.current = window.setTimeout(tick, state.waiting ? 1000 : 3000);
    };
    tick();
    return () => {
      cancelled = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    };
  }, [
    state.wsConnected,
    state.channelName,
    state.selectedAgent,
    state.waiting,
    state.hiddenKeysHydrated,
    runFetchHistory,
  ]);

  // ── activity-based "Agent did not respond" timer ──
  // Reset to 60s every time we observe activity: a new visible message OR a
  // loop-status transition into perceiving/thinking/acting. Cleared once the
  // reducer flips waiting=false (terminal message arrived).
  useEffect(() => {
    if (waitingTimerRef.current) {
      clearTimeout(waitingTimerRef.current);
      waitingTimerRef.current = null;
    }
    if (!state.waiting) return;
    waitingTimerRef.current = window.setTimeout(() => {
      dispatch({ type: 'WAITING_TIMEOUT' });
      dispatch({ type: 'CHAT_ERROR', text: 'Agent did not respond within 60s' });
    }, 60_000);
    return () => {
      if (waitingTimerRef.current) clearTimeout(waitingTimerRef.current);
      waitingTimerRef.current = null;
    };
  }, [state.waiting, state.messages.length, state.loop?.status]);

  // ── actions ──
  const handleSend = async (text: string, sentAttachments: Attachment[]) => {
    if (!state.wsConnected || state.sending || state.waiting) return;

    let fullText = text;
    if (sentAttachments.length) {
      const refs = sentAttachments.map((a, i) => ({
        ref: `#${i + 1}:${a.tag}`,
        selector: a.selector,
        tag: a.tag,
        ...(a.text ? { text: a.text.slice(0, 80) } : {}),
        ...(a.screenshot ? { screenshot: a.screenshot } : {}),
      }));
      fullText +=
        '\n\n```json\n' +
        JSON.stringify({ type: 'element_refs', refs }, null, 2) +
        '\n```';
    }

    const localMsg = {
      id: `local-${Date.now()}`,
      role: 'user' as const,
      content: text,
      attachments: sentAttachments,
    };
    dispatch({
      type: 'APPEND_LOCAL_ECHO',
      msg: localMsg,
      sentAttachments,
    });

    try {
      const res = await bg.ensureAndSend(sessionKey(), fullText);
      if (!res.ok) {
        const err = res.error || 'Unknown error';
        dispatch({ type: 'SEND_FAILED', error: err });
        return;
      }
      dispatch({ type: 'SEND_OK' });
      // The 60s "did not respond" timer is owned by an effect that watches
      // state.waiting / state.messages.length / state.loop?.status — every new
      // message or loop transition resets it. We do not start it here.
    } catch (e) {
      dispatch({ type: 'SEND_FAILED', error: (e as Error).message });
    }
  };

  const handleToggleLang = () => setLang(lang === 'en' ? 'zh' : 'en');

  const handleTogglePickMode = () => {
    if (!state.wsConnected) return;
    if (state.pickMode) {
      dispatch({ type: 'PICK_MODE_OFF' });
      bg.exitPickMode().catch(() => {});
    } else {
      dispatch({ type: 'PICK_MODE_ON' });
      bg.enterPickMode().catch(() => {});
    }
  };

  const handleClearContext = async () => {
    if (!state.wsConnected) return;
    if (!confirm(t(lang, 'clearContextConfirm'))) return;
    // Snapshot the soon-to-be-hidden keys before dispatch so we can persist
    // immediately without waiting on the debounced effect (the user might
    // close the sidepanel within those 250 ms).
    const hiddenForFlush = new Set(state.hiddenMsgKeys);
    for (const m of state.messages) hiddenForFlush.add(msgKey(m));
    for (const content of state.pendingEchoes.values()) {
      hiddenForFlush.add(`c:user|${content.slice(0, 300)}`);
    }
    dispatch({ type: 'CLEAR_CONTEXT' });
    if (state.channelName) {
      try {
        await chrome.storage.local.set({
          [hiddenStorageKey(sessionKey())]: Array.from(hiddenForFlush),
        });
      } catch (e) {
        clog('warn', 'hiddenKeys flush failed', { error: (e as Error).message });
      }
    }
    try {
      const res = await bg.resetContext(sessionKey());
      if (!res.ok) {
        dispatch({
          type: 'TOAST',
          text: t(lang, 'clearContextFailed'),
          error: true,
        });
      }
    } catch (e) {
      clog('error', 'clear context failed', { error: (e as Error).message });
      dispatch({
        type: 'TOAST',
        text: t(lang, 'clearContextFailed'),
        error: true,
      });
    }
  };

  const handleSwitchAgent = (a: string) => dispatch({ type: 'SWITCH_AGENT', agent: a });

  const handleRemoveAttachment = (i: number) =>
    dispatch({ type: 'REMOVE_ATTACHMENT', index: i });

  const handleToast = (text: string, error?: boolean) =>
    dispatch({ type: 'TOAST', text, error });

  // Called by ConfigPage when the user clicks Connect. Flipping state.connecting
  // to true synchronously gives the button its spinner + disables double-click.
  // The subsequent status_update broadcasts (reconnecting=true during WS open)
  // keep it true until wsConnected, pairingPending, or gaveUp flips it off via
  // the STATUS_UPDATE reducer case.
  const handleConnect = async (url: string, token: string, name: string) => {
    dispatch({ type: 'CONNECT_STARTED' });
    try {
      await bg.connect(url, token, name);
    } catch (e) {
      dispatch({ type: 'CONNECT_FAILED' });
      clog('error', 'connect RPC failed', { error: (e as Error).message });
    }
  };

  const visible = selectVisibleMessages(state);

  return (
    <>
      {state.page === 'chat' ? (
        <ChatPage
          lang={lang}
          onToggleLang={handleToggleLang}
          agent={state.selectedAgent}
          agents={state.availableAgents}
          onSwitchAgent={handleSwitchAgent}
          connected={state.wsConnected}
          reconnecting={state.reconnecting}
          loop={state.loop}
          messages={visible}
          waiting={state.waiting}
          sending={state.sending}
          chatError={state.chatError}
          pickMode={state.pickMode}
          attachments={state.attachments}
          onTogglePickMode={handleTogglePickMode}
          onClearContext={handleClearContext}
          onSend={handleSend}
          onRemoveAttachment={handleRemoveAttachment}
          onToast={handleToast}
          channelName={state.channelName}
        />
      ) : (
        <ConfigPage
          lang={lang}
          onToggleLang={handleToggleLang}
          connecting={state.connecting}
          gaveUp={state.gaveUp}
          pairingPending={state.pairingPending}
          pairingDeviceId={state.pairingDeviceId}
          onToast={handleToast}
          onConnect={handleConnect}
        />
      )}
      {state.toast ? (
        <Toast
          key={state.toast.id}
          text={state.toast.text}
          error={state.toast.error}
          onDismiss={() => dispatch({ type: 'TOAST_DISMISS' })}
        />
      ) : null}
    </>
  );
}
