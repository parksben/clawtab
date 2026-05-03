import { describe, it, expect } from 'vitest';
import { initialState, reducer, selectVisibleMessages } from './reducer';
import type { ChatMessage } from '@/shared/types/protocol';
import type { StatusSnapshot } from '@/shared/types/state';

const emptySnap = (patch: Partial<StatusSnapshot> = {}): StatusSnapshot => ({
  wsConnected: false,
  pairingPending: false,
  reconnecting: false,
  gaveUp: false,
  deviceId: '',
  browserId: '',
  wsUrl: '',
  tabCount: 0,
  lastCmd: '',
  loop: {
    status: 'idle',
    goal: '',
    agentId: '',
    stepIndex: 0,
    history: [],
    lastScreenshot: null,
    lastUrl: '',
    lastTitle: '',
    statusText: '',
    errorMsg: '',
    startedAt: null,
  },
  ...patch,
});

describe('initialState', () => {
  it('starts disconnected on the config page', () => {
    const s = initialState();
    expect(s.wsConnected).toBe(false);
    expect(s.page).toBe('config');
    expect(s.messages).toEqual([]);
  });
});

describe('STATUS_UPDATE page routing', () => {
  it('routes to chat on wsConnected=true', () => {
    const s1 = reducer(
      initialState(),
      { type: 'STATUS_UPDATE', snapshot: emptySnap({ wsConnected: true, browserId: 'a' }) },
    );
    expect(s1.page).toBe('chat');
    expect(s1.wsConnected).toBe(true);
  });
  it('routes to config on pairingPending even if wsConnected', () => {
    // Shouldn't happen in practice but we pin the precedence.
    const s1 = reducer(
      initialState(),
      {
        type: 'STATUS_UPDATE',
        snapshot: emptySnap({ wsConnected: false, pairingPending: true, deviceId: 'abc' }),
      },
    );
    expect(s1.page).toBe('config');
    expect(s1.pairingPending).toBe(true);
    expect(s1.pairingDeviceId).toBe('abc');
  });
  it('clears messages + lastMsgId when channelName transitions', () => {
    let s0 = reducer(initialState(), {
      type: 'STATUS_UPDATE',
      snapshot: emptySnap({ wsConnected: true, browserId: 'chan-a' }),
    });
    s0 = reducer(s0, { type: 'HYDRATE_HIDDEN_KEYS', keys: [] });
    const withMsgs = reducer(s0, {
      type: 'HYDRATE_HISTORY',
      fetched: [{ id: '1', role: 'user', content: 'hi' }],
    });
    expect(withMsgs.messages).toHaveLength(1);

    // disconnect
    const sDisc = reducer(withMsgs, {
      type: 'STATUS_UPDATE',
      snapshot: emptySnap({ wsConnected: false, browserId: 'chan-a' }),
    });
    // reconnect with a DIFFERENT channel
    const sNew = reducer(sDisc, {
      type: 'STATUS_UPDATE',
      snapshot: emptySnap({ wsConnected: true, browserId: 'chan-b' }),
    });
    expect(sNew.messages).toEqual([]);
    expect(sNew.lastMsgId).toBeNull();
  });
});

describe('HYDRATE_HISTORY dedup', () => {
  // Hydrate the persisted blocklist gate so HYDRATE_HISTORY doesn't no-op.
  const hydrate = (s: ReturnType<typeof initialState>) =>
    reducer(s, { type: 'HYDRATE_HIDDEN_KEYS', keys: [] });

  it('ignores messages already present by id', () => {
    const s0 = hydrate(initialState());
    const s1 = reducer(s0, {
      type: 'HYDRATE_HISTORY',
      fetched: [{ id: 'x', role: 'user', content: 'hi' }],
    });
    const s2 = reducer(s1, {
      type: 'HYDRATE_HISTORY',
      fetched: [
        { id: 'x', role: 'user', content: 'hi' },
        { id: 'y', role: 'assistant', content: 'hello' },
      ],
    });
    expect(s2.messages).toHaveLength(2);
  });
  it('dedups messages without id by role+content (handshake case)', () => {
    const HANDSHAKE = '🦾 **ClawTab 已连接**\n浏览器：`x`';
    const s0 = hydrate(initialState());
    const s1 = reducer(s0, {
      type: 'HYDRATE_HISTORY',
      fetched: [{ role: 'user', content: HANDSHAKE }],
    });
    const s2 = reducer(s1, {
      type: 'HYDRATE_HISTORY',
      fetched: [{ role: 'user', content: HANDSHAKE }],
    });
    expect(s2.messages).toHaveLength(1);
  });
  it('dedups within one batch', () => {
    const s0 = hydrate(initialState());
    const s1 = reducer(s0, {
      type: 'HYDRATE_HISTORY',
      fetched: [
        { id: 'a', role: 'user', content: 'x' },
        { id: 'a', role: 'user', content: 'x' },
      ],
    });
    expect(s1.messages).toHaveLength(1);
  });
  it('replaces local-XXX echo with server version', () => {
    const s0 = hydrate(initialState());
    const s1 = reducer(s0, {
      type: 'APPEND_LOCAL_ECHO',
      msg: { id: 'local-1', role: 'user', content: 'hey' },
      sentAttachments: [],
    });
    expect(s1.pendingEchoes.get('local-1')).toBe('hey');
    const s2 = reducer(s1, {
      type: 'HYDRATE_HISTORY',
      fetched: [{ id: 'server-9', role: 'user', content: 'hey' }],
    });
    expect(s2.messages).toHaveLength(1);
    expect(s2.messages[0].id).toBe('server-9');
    expect(s2.pendingEchoes.size).toBe(0);
  });
  it('two-message rapid send: each local- gets the right server msg', () => {
    // Reproduces the bug where sending two messages in quick succession (before
    // polling caught up to the first) caused message #1's bubble to be
    // overwritten with message #2's text. After the fix, each local-id maps to
    // exactly its own server message.
    let s = hydrate(initialState());
    s = reducer(s, {
      type: 'APPEND_LOCAL_ECHO',
      msg: { id: 'local-1', role: 'user', content: 'Hi' },
      sentAttachments: [],
    });
    s = reducer(s, {
      type: 'APPEND_LOCAL_ECHO',
      msg: { id: 'local-2', role: 'user', content: 'How are you' },
      sentAttachments: [],
    });
    expect(s.messages.map((m) => m.id)).toEqual(['local-1', 'local-2']);
    s = reducer(s, {
      type: 'HYDRATE_HISTORY',
      fetched: [
        { id: 'server-1', role: 'user', content: 'Hi' },
        { id: 'server-2', role: 'user', content: 'How are you' },
      ],
    });
    expect(s.messages.map((m) => m.id)).toEqual(['server-1', 'server-2']);
    expect(s.pendingEchoes.size).toBe(0);
  });
  it('drops toolResult messages before they reach state.messages', () => {
    const s0 = hydrate(initialState());
    const s1 = reducer(s0, {
      type: 'HYDRATE_HISTORY',
      fetched: [
        { id: '1', role: 'assistant', content: 'real reply' },
        {
          id: '2',
          role: 'toolResult',
          content: [{ type: 'text', text: '{"big":"json dump"}' }],
        },
      ],
    });
    expect(s1.messages).toHaveLength(1);
    expect(s1.messages[0].id).toBe('1');
  });
  it('drops inter_session user echoes', () => {
    const s0 = hydrate(initialState());
    const s1 = reducer(s0, {
      type: 'HYDRATE_HISTORY',
      fetched: [
        { id: 'real', role: 'user', content: 'hi' },
        {
          id: 'echo',
          role: 'user',
          content: '```json\n{"type":"clawtab_cmd","action":"perceive"}\n```',
          provenance: { kind: 'inter_session', sourceTool: 'sessions_send' },
        },
      ],
    });
    expect(s1.messages).toHaveLength(1);
    expect(s1.messages[0].id).toBe('real');
  });
  it('returns state unchanged when hiddenKeys not yet hydrated', () => {
    // Without the gate, a fast first poll would surface freshly-cleared msgs.
    const s0 = initialState(); // hiddenKeysHydrated=false
    const s1 = reducer(s0, {
      type: 'HYDRATE_HISTORY',
      fetched: [{ id: '1', role: 'user', content: 'hi' }],
    });
    expect(s1).toBe(s0); // identity-equal: no work happened
  });
});

describe('CLEAR_CONTEXT blocks gateway re-hydration', () => {
  // Reproduces the bug where clicking "new conversation" briefly emptied
  // the message list, then the next polling cycle pulled the same messages
  // back from chat.history (gateway preserves history through `/new`).
  const HANDSHAKE = '🦾 ClawTab 已连接\n浏览器: x · 11 个标签页';
  const NEW_HANDSHAKE = '🦾 ClawTab 已连接\n浏览器: x · 8 个标签页';
  const hydrate = (s: ReturnType<typeof initialState>) =>
    reducer(s, { type: 'HYDRATE_HIDDEN_KEYS', keys: [] });

  it('drops cleared messages when chat.history replays them', () => {
    let s = hydrate(initialState());
    s = reducer(s, {
      type: 'HYDRATE_HISTORY',
      fetched: [
        { id: 'h1', role: 'user', content: HANDSHAKE },
        { id: 'a1', role: 'assistant', content: 'Got it.' },
      ],
    });
    expect(s.messages).toHaveLength(2);

    s = reducer(s, { type: 'CLEAR_CONTEXT' });
    expect(s.messages).toEqual([]);

    // Polling tick during/right after the reset returns the same history
    // plus a brand-new post-clear message — the cleared ones must stay gone.
    s = reducer(s, {
      type: 'HYDRATE_HISTORY',
      fetched: [
        { id: 'h1', role: 'user', content: HANDSHAKE },
        { id: 'a1', role: 'assistant', content: 'Got it.' },
        { id: 'h2', role: 'user', content: NEW_HANDSHAKE },
        { id: 'a2', role: 'assistant', content: '新会话已开始。' },
      ],
    });
    const ids = s.messages.map((m) => m.id);
    expect(ids).toEqual(['h2', 'a2']);
  });

  it('keeps blocklist scoped — channel change wipes it', () => {
    let s = reducer(initialState(), {
      type: 'STATUS_UPDATE',
      snapshot: emptySnap({ wsConnected: true, browserId: 'chan-a' }),
    });
    s = hydrate(s);
    s = reducer(s, {
      type: 'HYDRATE_HISTORY',
      fetched: [{ id: 'a1', role: 'user', content: 'hi' }],
    });
    s = reducer(s, { type: 'CLEAR_CONTEXT' });
    expect(s.hiddenMsgKeys.size).toBeGreaterThan(0);

    // Disconnect → reconnect on a different channel; blocklist resets,
    // hydration flag resets too (App will re-load the new channel's keys).
    s = reducer(s, {
      type: 'STATUS_UPDATE',
      snapshot: emptySnap({ wsConnected: false, browserId: 'chan-a' }),
    });
    s = reducer(s, {
      type: 'STATUS_UPDATE',
      snapshot: emptySnap({ wsConnected: true, browserId: 'chan-b' }),
    });
    expect(s.hiddenMsgKeys.size).toBe(0);
    expect(s.hiddenKeysHydrated).toBe(false);
  });

  it('HYDRATE_HIDDEN_KEYS replays blocklist from storage on reopen', () => {
    // Simulate: user clears, sidepanel closed, reopens; App loads persisted
    // keys; gateway replays cleared messages — must stay hidden.
    let s = initialState();
    s = reducer(s, {
      type: 'HYDRATE_HIDDEN_KEYS',
      keys: ['id:h1', 'id:a1'],
    });
    expect(s.hiddenKeysHydrated).toBe(true);
    expect(s.hiddenMsgKeys.has('id:h1')).toBe(true);

    s = reducer(s, {
      type: 'HYDRATE_HISTORY',
      fetched: [
        { id: 'h1', role: 'user', content: HANDSHAKE },
        { id: 'a1', role: 'assistant', content: 'Got it.' },
        { id: 'h2', role: 'user', content: NEW_HANDSHAKE },
      ],
    });
    expect(s.messages.map((m) => m.id)).toEqual(['h2']);
  });
});

describe('selectVisibleMessages', () => {
  const mkState = (messages: ChatMessage[]) => ({ ...initialState(), messages });

  it('filters /new reset commands', () => {
    const v = selectVisibleMessages(
      mkState([
        { id: '1', role: 'user', content: '/new' },
        { id: '2', role: 'assistant', content: 'resetting' },
      ]),
    );
    expect(v).toHaveLength(1);
    expect(v[0].id).toBe('2');
  });
  it('filters clawtab_result json blocks', () => {
    const v = selectVisibleMessages(
      mkState([
        {
          id: '1',
          role: 'assistant',
          content: '```json\n{"type":"clawtab_result","cmdId":"c1","ok":true}\n```',
        },
        { id: '2', role: 'assistant', content: 'Here is the summary.' },
      ]),
    );
    expect(v).toHaveLength(1);
    expect(v[0].id).toBe('2');
  });
  it('filters TRUNCATED clawtab_result blocks (gateway 12KB cap)', () => {
    // When perceive results carry a base64 screenshot, the gateway truncates
    // the JSON payload mid-string. JSON.parse fails, but the `"type":"clawtab_result"`
    // token is still present near the top. Regex-based detection survives.
    const truncated =
      '```json\n{"type":"clawtab_result","cmdId":"perceive-008","ok":true,"data":{"screenshot":"data:image/jpeg;base64,/9j/4AAQSkZJRg' +
      'A'.repeat(8000) +
      '...(truncated)...';
    const v = selectVisibleMessages(
      mkState([
        { id: '1', role: 'user', content: truncated },
        { id: '2', role: 'assistant', content: 'ok' },
      ]),
    );
    expect(v.map((x) => x.id)).toEqual(['2']);
  });
  it('keeps clawtab_cmd (rendered as icon rows)', () => {
    const v = selectVisibleMessages(
      mkState([
        {
          id: '1',
          role: 'assistant',
          content: '```json\n{"type":"clawtab_cmd","action":"perceive"}\n```',
        },
      ]),
    );
    expect(v).toHaveLength(1);
  });
  it('filters role:"toolResult" entries (web_fetch / sessions_send dumps)', () => {
    const v = selectVisibleMessages(
      mkState([
        {
          id: '1',
          role: 'toolResult',
          content: [{ type: 'text', text: '{"runId":"...","status":"timeout"}' }],
        },
        { id: '2', role: 'assistant', content: 'real reply' },
      ]),
    );
    expect(v.map((m) => m.id)).toEqual(['2']);
  });
  it('filters inter_session user echoes', () => {
    const v = selectVisibleMessages(
      mkState([
        {
          id: '1',
          role: 'user',
          content: '```json\n{"type":"clawtab_cmd","action":"perceive"}\n```',
          provenance: { kind: 'inter_session', sourceTool: 'sessions_send' },
        },
        { id: '2', role: 'user', content: 'hello' },
      ]),
    );
    expect(v.map((m) => m.id)).toEqual(['2']);
  });
});

describe('waiting / terminal interplay', () => {
  const hydrate = (s: ReturnType<typeof initialState>) =>
    reducer(s, { type: 'HYDRATE_HIDDEN_KEYS', keys: [] });

  it('SEND_OK flips waiting=true', () => {
    const s0 = reducer(initialState(), {
      type: 'APPEND_LOCAL_ECHO',
      msg: { id: 'local-1', role: 'user', content: 'q' },
      sentAttachments: [],
    });
    const s1 = reducer(s0, { type: 'SEND_OK' });
    expect(s1.waiting).toBe(true);
  });
  it('HYDRATE_HISTORY with a terminal assistant msg clears waiting', () => {
    let s = hydrate(initialState());
    s = reducer(s, {
      type: 'APPEND_LOCAL_ECHO',
      msg: { id: 'local-1', role: 'user', content: 'q' },
      sentAttachments: [],
    });
    s = reducer(s, { type: 'SEND_OK' });
    expect(s.waiting).toBe(true);
    s = reducer(s, {
      type: 'HYDRATE_HISTORY',
      fetched: [{ id: 's-1', role: 'assistant', content: 'answer' }],
    });
    expect(s.waiting).toBe(false);
  });
});
