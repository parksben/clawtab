// Sidebar reducer — pure, testable.
//
// Mirrors the STATE object from the old sidebar.js, but shaped so component
// state flows through useReducer and every transition is traceable. The
// runtime side-effects (chrome.runtime messaging, timers) live in hooks;
// this file is pure so Vitest can exercise the edge cases in phase 5.

import type { ChatMessage } from '@/shared/types/protocol';
import type { StatusSnapshot } from '@/shared/types/state';
import type { PickedElement } from '@/shared/types/picker';
import { msgKey, isHiddenInfraMsg } from '../lib/message-utils';

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
  /** raw text of the user message we just posted; used for local-echo swap */
  pendingEchoContent: string | null;
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
    pendingEchoContent: null,
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
      let pendingEcho = state.pendingEchoContent;
      if (!wasConnected && s.wsConnected && channelChanged) {
        messages = [];
        lastMsgId = null;
        pendingEcho = null;
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
        pendingEchoContent: pendingEcho,
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
        waiting: false,
      };

    case 'HYDRATE_HISTORY': {
      // Dedup against existing msgKey() set; also dedup within the fetched
      // batch (intra-response duplicates happen on flaky gateways).
      const seen = new Set(state.messages.map(msgKey));
      const fresh: ChatMessage[] = [];
      let newLast = state.lastMsgId;
      for (const m of action.fetched) {
        if (m.id) newLast = m.id;
        const k = msgKey(m);
        if (seen.has(k)) continue;
        seen.add(k);
        fresh.push(m);
      }
      if (fresh.length === 0) return { ...state, lastMsgId: newLast };

      // Local-echo replacement — find the server version of our pending user
      // message and replace the local-XXX placeholder in-place.
      let messages = state.messages;
      let pendingEcho = state.pendingEchoContent;
      if (pendingEcho !== null) {
        const idx = fresh.findIndex(
          (m) =>
            m.role === 'user' &&
            // msgText inline to keep reducer free of IO
            (typeof m.content === 'string'
              ? m.content
              : Array.isArray(m.content)
                ? m.content
                    .filter((b) => b.type === 'text')
                    .map((b) => b.text || '')
                    .join('')
                : m.blocks
                  ? m.blocks
                      .filter((b) => b.type === 'text')
                      .map((b) => b.text || '')
                      .join('')
                  : '') === pendingEcho,
        );
        if (idx !== -1) {
          const localIdx = messages.findIndex((m) => m.id?.startsWith('local-'));
          const copy = messages.slice();
          if (localIdx !== -1) copy[localIdx] = fresh[idx];
          else copy.push(fresh[idx]);
          messages = copy;
          fresh.splice(idx, 1);
          pendingEcho = null;
        }
      }

      // If any fresh message is terminal, clear waiting flag so the thinking
      // indicator hides and the send button re-enables.
      const hasTerminal = fresh.some((m) => {
        if (m.role !== 'assistant') return false;
        const text =
          typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content
                  .filter((b) => b.type === 'text')
                  .map((b) => b.text || '')
                  .join('')
              : m.blocks
                ? m.blocks
                    .filter((b) => b.type === 'text')
                    .map((b) => b.text || '')
                    .join('')
                : '';
        return text.replace(/```json[\s\S]*?```/g, '').trim().length > 0;
      });

      return {
        ...state,
        messages: messages.concat(fresh),
        lastMsgId: newLast,
        pendingEchoContent: pendingEcho,
        waiting: hasTerminal ? false : state.waiting,
      };
    }

    case 'APPEND_LOCAL_ECHO':
      return {
        ...state,
        messages: state.messages.concat(action.msg),
        pendingEchoContent:
          typeof action.msg.content === 'string' ? action.msg.content : null,
        attachments: [],
        sending: true,
      };

    case 'SEND_STARTED':
      return { ...state, sending: true };

    case 'SEND_OK':
      return { ...state, sending: false, waiting: true };

    case 'SEND_FAILED':
      return {
        ...state,
        sending: false,
        waiting: false,
        pendingEchoContent: null,
        chatError: action.error,
      };

    case 'CLEAR_CONTEXT':
      return {
        ...state,
        messages: [],
        lastMsgId: null,
        pendingEchoContent: null,
        waiting: false,
        sending: false,
      };

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

// Visible-message selector (filters out clawtab_result + /new + empty shells).
export function selectVisibleMessages(state: SidebarStateShape): ChatMessage[] {
  return state.messages.filter((m) => {
    if (isHiddenInfraMsg(m)) return false;
    const text =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text || '')
              .join('')
          : m.blocks
            ? m.blocks
                .filter((b) => b.type === 'text')
                .map((b) => b.text || '')
                .join('')
            : '';
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
