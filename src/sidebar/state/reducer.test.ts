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
    const s0 = reducer(initialState(), {
      type: 'STATUS_UPDATE',
      snapshot: emptySnap({ wsConnected: true, browserId: 'chan-a' }),
    });
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
  it('ignores messages already present by id', () => {
    const s0 = initialState();
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
    const s0 = initialState();
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
    const s0 = initialState();
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
    const s0 = initialState();
    const s1 = reducer(s0, {
      type: 'APPEND_LOCAL_ECHO',
      msg: { id: 'local-1', role: 'user', content: 'hey' },
      sentAttachments: [],
    });
    expect(s1.pendingEchoContent).toBe('hey');
    const s2 = reducer(s1, {
      type: 'HYDRATE_HISTORY',
      fetched: [{ id: 'server-9', role: 'user', content: 'hey' }],
    });
    expect(s2.messages).toHaveLength(1);
    expect(s2.messages[0].id).toBe('server-9');
    expect(s2.pendingEchoContent).toBeNull();
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
});

describe('waiting / terminal interplay', () => {
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
    let s = initialState();
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
