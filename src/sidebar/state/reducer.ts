// Sidebar reducer — pure, testable.
//
// Mirrors the STATE object from the old sidebar.js, but shaped so component
// state flows through useReducer and every transition is traceable. The
// runtime side-effects (chrome.runtime messaging, timers) live in hooks;
// this file is pure so Vitest can exercise the edge cases in phase 5.

import type { ChatMessage } from '@/shared/types/protocol';
import type { StatusSnapshot } from '@/shared/types/state';
import type { PickedElement } from '@/shared/types/picker';
import {
  msgKey,
  msgText,
  isHiddenInfraMsg,
  isToolResultMsg,
  isInterSessionEcho,
} from '../lib/message-utils';

export interface Attachment {
  tag: string;
  id?: string;
  classes: string[];
  text: string;
  selector: string;
  screenshot?: string;
}

export interface TabDraft {
  input: string;
  attachments: Attachment[];
}

export interface SidebarStateShape {
  // Connection
  wsConnected: boolean;
  reconnecting: boolean;
  /** true while a user-initiated `connect` RPC is in flight */
  connecting: boolean;
  pairingPending: boolean;
  pairingDeviceId: string | null;
  gaveUp: boolean;
  channelName: string;

  // Agent + session
  selectedAgent: string;
  availableAgents: string[];

  // Messages
  messages: ChatMessage[];
  lastMsgId: string | null;
  /**
   * Keys (msgKey) of messages that the user has explicitly cleared via the
   * "new conversation" button. The gateway preserves chat history across the
   * `/new` slash command, so we have to filter the carry-over messages
   * client-side — without this, the next polling tick would re-hydrate the
   * just-cleared conversation. Persisted to chrome.storage.local under
   * `hidden_<sessionKey>` so it survives sidepanel reopens.
   */
  hiddenMsgKeys: Set<string>;
  /**
   * True once we've finished loading hidden_<sessionKey> from storage for the
   * current channel. Polling waits for this gate before letting HYDRATE_HISTORY
   * append; otherwise a fast first tick would surface freshly-cleared messages
   * because the blocklist hasn't loaded yet.
   */
  hiddenKeysHydrated: boolean;
  /**
   * Outstanding local-echo placeholders, keyed by their `local-<ts>` id. Each
   * entry's value is the message text we sent. When server-side history echoes
   * the same content back, we use this map to find which local placeholder to
   * replace — never "the first local-" (that bug had message #1's bubble
   * adopting message #2's text when the user sent two in quick succession).
   */
  pendingEchoes: Map<string, string>;
  /** true while the user's last send hasn't produced a terminal response yet */
  waiting: boolean;
  /** true while a send() is mid-flight (message not yet ACKed) */
  sending: boolean;

  // Loop/task bar
  loop: StatusSnapshot['loop'] | null;

  // Element picker
  pickMode: boolean;
  attachments: Attachment[];
  activeTabId: number | null;
  tabDrafts: Record<number, TabDraft>;

  // UI
  page: 'config' | 'chat';
  /** transient toast message */
  toast: { text: string; error: boolean; id: number } | null;
  /** transient in-chat error row */
  chatError: string | null;
}

export function initialState(): SidebarStateShape {
  return {
    wsConnected: false,
    reconnecting: false,
    connecting: false,
    pairingPending: false,
    pairingDeviceId: null,
    gaveUp: false,
    channelName: '',

    selectedAgent: 'main',
    availableAgents: ['main', 'dajin', 'coder', 'wechat-new', 'biz-coder'],

    messages: [],
    lastMsgId: null,
    hiddenMsgKeys: new Set<string>(),
    hiddenKeysHydrated: false,
    pendingEchoes: new Map<string, string>(),
    waiting: false,
    sending: false,

    loop: null,

    pickMode: false,
    attachments: [],
    activeTabId: null,
    tabDrafts: {},

    page: 'config',
    toast: null,
    chatError: null,
  };
}

// ── Actions ──────────────────────────────────────────────────────────────────

export type Action =
  // Connection / page routing driven by status_update
  | { type: 'STATUS_UPDATE'; snapshot: StatusSnapshot }
  | { type: 'CONNECT_STARTED' }
  | { type: 'CONNECT_FAILED' }
  | { type: 'SHOW_CONFIG' }

  // Agents
  | { type: 'SET_AGENTS'; agents: string[] }
  | { type: 'SWITCH_AGENT'; agent: string }

  // Messages
  | { type: 'HYDRATE_HISTORY'; fetched: ChatMessage[] }
  | { type: 'HYDRATE_HIDDEN_KEYS'; keys: string[] }
  | { type: 'APPEND_LOCAL_ECHO'; msg: ChatMessage; sentAttachments: Attachment[] }
  | { type: 'SEND_STARTED' }
  | { type: 'SEND_OK' }
  | { type: 'SEND_FAILED'; error: string }
  | { type: 'CLEAR_CONTEXT' }
  | { type: 'WAITING_TIMEOUT' }
  | { type: 'CHAT_ERROR'; text: string }
  | { type: 'CHAT_ERROR_DISMISS' }

  // Picker + attachments
  | { type: 'PICK_MODE_ON' }
  | { type: 'PICK_MODE_OFF' }
  | { type: 'ELEMENT_PICKED'; element: PickedElement }
  | { type: 'REMOVE_ATTACHMENT'; index: number }
  | { type: 'CLEAR_ATTACHMENTS' }

  // Tab draft save/restore
  | { type: 'TAB_ACTIVATED'; tabId: number; currentDraft: TabDraft }

  // Toast
  | { type: 'TOAST'; text: string; error?: boolean }
  | { type: 'TOAST_DISMISS' };

// ── Reducer ──────────────────────────────────────────────────────────────────

export function reducer(state: SidebarStateShape, action: Action): SidebarStateShape {
  switch (action.type) {
    case 'STATUS_UPDATE': {
      const s = action.snapshot;
      const wasConnected = state.wsConnected;
      const channelChanged =
        !!state.channelName && !!s.browserId && state.channelName !== s.browserId;

      let messages = state.messages;
      let lastMsgId = state.lastMsgId;
      let pendingEchoes = state.pendingEchoes;
      let hiddenMsgKeys = state.hiddenMsgKeys;
      let hiddenKeysHydrated = state.hiddenKeysHydrated;
      if (!wasConnected && s.wsConnected && channelChanged) {
        messages = [];
        lastMsgId = null;
        pendingEchoes = new Map<string, string>();
        // Different channel → start with a fresh blocklist (the cleared
        // messages from the OLD channel can't possibly show up in the new
        // one's chat.history). The App-side effect will then load the new
        // channel's persisted blocklist via HYDRATE_HIDDEN_KEYS.
        hiddenMsgKeys = new Set<string>();
        hiddenKeysHydrated = false;
      }

      // On connect transition, clear waiting flags
      const transitioningConnected = !wasConnected && s.wsConnected;
      const transitioningDisconnected = wasConnected && !s.wsConnected;

      let page: SidebarStateShape['page'] = state.page;
      if (s.pairingPending) page = 'config';
      else if (s.wsConnected) page = 'chat';
      else page = 'config';

      return {
        ...state,
        wsConnected: s.wsConnected,
        reconnecting: s.reconnecting,
        pairingPending: s.pairingPending,
        pairingDeviceId: s.pairingPending ? s.deviceId || null : null,
        gaveUp: s.gaveUp || false,
        channelName: s.browserId || state.channelName,
        loop: s.loop,
        connecting:
          s.pairingPending || s.wsConnected
            ? false
            : s.reconnecting && !s.gaveUp
              ? state.connecting
              : false,
        page,
        messages,
        lastMsgId,
        hiddenMsgKeys,
        hiddenKeysHydrated,
        pendingEchoes,
        waiting: transitioningDisconnected || transitioningConnected ? false : state.waiting,
        sending: transitioningDisconnected ? false : state.sending,
        pickMode: transitioningDisconnected ? false : state.pickMode,
      };
    }

    case 'CONNECT_STARTED':
      return { ...state, connecting: true };

    case 'CONNECT_FAILED':
      return { ...state, connecting: false };

    case 'SHOW_CONFIG':
      return {
        ...state,
        page: 'config',
        pairingPending: false,
        pairingDeviceId: null,
      };

    case 'SET_AGENTS':
      return { ...state, availableAgents: action.agents };

    case 'SWITCH_AGENT':
      if (action.agent === state.selectedAgent) return state;
      return {
        ...state,
        selectedAgent: action.agent,
        messages: [],
        lastMsgId: null,
        hiddenMsgKeys: new Set<string>(),
        hiddenKeysHydrated: false,
        pendingEchoes: new Map<string, string>(),
        waiting: false,
      };

    case 'HYDRATE_HIDDEN_KEYS':
      // App-level effect calls this once per channel after reading
      // chrome.storage.local. Only set the gate after we've absorbed any keys.
      return {
        ...state,
        hiddenMsgKeys: new Set<string>([
          ...state.hiddenMsgKeys,
          ...action.keys,
        ]),
        hiddenKeysHydrated: true,
      };

    case 'HYDRATE_HISTORY': {
      // Wait until the persisted blocklist has loaded — otherwise a fast first
      // poll tick would re-hydrate freshly cleared messages before
      // hiddenMsgKeys arrives. App.tsx gates the polling effect on this flag,
      // but we keep the reducer-side guard as a belt-and-braces.
      if (!state.hiddenKeysHydrated) return state;

      // Filter at the source: hide messages that should never reach the chat
      // list (toolResult dumps, inter-session command echoes). They still
      // count for lastSeenMsgId tracking on the background side, but we never
      // append them to state.messages, so MessageBubble never has to know.
      const visible = action.fetched.filter(
        (m) => !isToolResultMsg(m) && !isInterSessionEcho(m),
      );

      // Dedup against existing msgKey() set; also dedup within the fetched
      // batch (intra-response duplicates happen on flaky gateways).
      const seen = new Set(state.messages.map(msgKey));
      const fresh: ChatMessage[] = [];
      let newLast = state.lastMsgId;
      for (const m of visible) {
        if (m.id) newLast = m.id;
        const k = msgKey(m);
        // Drop messages the user explicitly cleared via "new conversation".
        // The gateway keeps these in chat.history across `/new`, so without
        // this gate the next poll would just re-hydrate the cleared chat.
        if (state.hiddenMsgKeys.has(k)) continue;
        if (seen.has(k)) continue;
        seen.add(k);
        fresh.push(m);
      }
      if (fresh.length === 0) return { ...state, lastMsgId: newLast };

      // Local-echo replacement — for each pending echo (keyed by localId),
      // find the server-version that matches its content and swap into the
      // matching `local-<id>` slot. Crucially, we look up by localId rather
      // than "first local-": when two messages are sent back-to-back, the
      // first replacement must hit the first local placeholder, not whichever
      // pending echo we happen to inspect first.
      let messages = state.messages;
      let pendingEchoes = state.pendingEchoes;
      if (pendingEchoes.size > 0 && fresh.length > 0) {
        const remainingFresh: ChatMessage[] = [];
        const consumedFresh = new Set<number>();
        const nextEchoes = new Map(pendingEchoes);
        const nextMessages = messages.slice();

        for (let fi = 0; fi < fresh.length; fi++) {
          const fm = fresh[fi];
          if (fm.role !== 'user') continue;
          const fmText = msgText(fm);
          // Find a pending echo with this exact text.
          let matchedLocalId: string | null = null;
          for (const [localId, content] of nextEchoes) {
            if (content === fmText) {
              matchedLocalId = localId;
              break;
            }
          }
          if (matchedLocalId == null) continue;
          const localIdx = nextMessages.findIndex((mm) => mm.id === matchedLocalId);
          if (localIdx === -1) {
            // The placeholder has already been replaced or cleared; just drop
            // the pending echo so we don't double-consume.
            nextEchoes.delete(matchedLocalId);
            continue;
          }
          nextMessages[localIdx] = fm;
          nextEchoes.delete(matchedLocalId);
          consumedFresh.add(fi);
        }

        for (let fi = 0; fi < fresh.length; fi++) {
          if (!consumedFresh.has(fi)) remainingFresh.push(fresh[fi]);
        }

        messages = nextMessages;
        pendingEchoes = nextEchoes;
        fresh.length = 0;
        Array.prototype.push.apply(fresh, remainingFresh);
      }

      // If any fresh message is terminal, clear waiting flag so the thinking
      // indicator hides and the send button re-enables.
      const hasTerminal = fresh.some((m) => {
        if (m.role !== 'assistant') return false;
        const text = msgText(m);
        return text.replace(/```json[\s\S]*?```/g, '').trim().length > 0;
      });

      return {
        ...state,
        messages: messages.concat(fresh),
        lastMsgId: newLast,
        pendingEchoes,
        waiting: hasTerminal ? false : state.waiting,
      };
    }

    case 'APPEND_LOCAL_ECHO': {
      const localId = action.msg.id;
      const text =
        typeof action.msg.content === 'string' ? action.msg.content : '';
      const nextEchoes = new Map(state.pendingEchoes);
      if (localId && text) nextEchoes.set(localId, text);
      return {
        ...state,
        messages: state.messages.concat(action.msg),
        pendingEchoes: nextEchoes,
        attachments: [],
        sending: true,
      };
    }

    case 'SEND_STARTED':
      return { ...state, sending: true };

    case 'SEND_OK':
      return { ...state, sending: false, waiting: true };

    case 'SEND_FAILED':
      return {
        ...state,
        sending: false,
        waiting: false,
        pendingEchoes: new Map<string, string>(),
        chatError: action.error,
      };

    case 'CLEAR_CONTEXT': {
      // Snapshot every key currently visible (plus pending echoes, if any)
      // so the polling round-trip that follows can't replay them. The gateway
      // preserves chat.history through `/new`, so the only thing that keeps
      // the cleared messages from coming back is this client-side blocklist
      // (which App.tsx persists to chrome.storage.local for cross-reopen
      // survival).
      const hidden = new Set(state.hiddenMsgKeys);
      for (const m of state.messages) hidden.add(msgKey(m));
      for (const content of state.pendingEchoes.values()) {
        hidden.add(`c:user|${content.slice(0, 300)}`);
      }
      return {
        ...state,
        messages: [],
        lastMsgId: null,
        hiddenMsgKeys: hidden,
        pendingEchoes: new Map<string, string>(),
        waiting: false,
        sending: false,
      };
    }

    case 'WAITING_TIMEOUT':
      return { ...state, waiting: false, chatError: state.chatError };

    case 'CHAT_ERROR':
      return { ...state, chatError: action.text };

    case 'CHAT_ERROR_DISMISS':
      return { ...state, chatError: null };

    case 'PICK_MODE_ON':
      return { ...state, pickMode: true };

    case 'PICK_MODE_OFF':
      return { ...state, pickMode: false };

    case 'ELEMENT_PICKED':
      return {
        ...state,
        pickMode: false,
        attachments: state.attachments.concat({
          tag: action.element.tag,
          id: action.element.id,
          classes: action.element.classes,
          text: action.element.text,
          selector: action.element.selector,
          screenshot: action.element.screenshot,
        }),
      };

    case 'REMOVE_ATTACHMENT': {
      const copy = state.attachments.slice();
      copy.splice(action.index, 1);
      return { ...state, attachments: copy };
    }

    case 'CLEAR_ATTACHMENTS':
      return { ...state, attachments: [] };

    case 'TAB_ACTIVATED': {
      if (state.activeTabId === action.tabId) return state;
      const tabDrafts = { ...state.tabDrafts };
      if (state.activeTabId != null) {
        tabDrafts[state.activeTabId] = action.currentDraft;
      }
      const next = tabDrafts[action.tabId];
      return {
        ...state,
        activeTabId: action.tabId,
        attachments: next ? [...next.attachments] : [],
        pickMode: false,
        tabDrafts,
      };
    }

    case 'TOAST':
      return {
        ...state,
        toast: { text: action.text, error: !!action.error, id: Date.now() },
      };

    case 'TOAST_DISMISS':
      return { ...state, toast: null };

    default:
      return state;
  }
}

// Visible-message selector (filters out clawtab_result + /new + tool dumps +
// inter-session echoes + empty shells).
export function selectVisibleMessages(state: SidebarStateShape): ChatMessage[] {
  return state.messages.filter((m) => {
    if (isHiddenInfraMsg(m)) return false;
    if (isToolResultMsg(m)) return false;
    if (isInterSessionEcho(m)) return false;
    const text = msgText(m);
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const j = JSON.parse(jsonMatch[1]) as { type?: string };
        if (j.type === 'clawtab_result') return false;
      } catch {
        /* ignore — keep message */
      }
    }
    if (text.trim()) return true;
    const blocks = Array.isArray(m.content)
      ? (m.content as Array<{ type: string }>)
      : Array.isArray(m.blocks)
        ? m.blocks
        : [];
    return blocks.some((b) => b.type === 'tool_use');
  });
}
