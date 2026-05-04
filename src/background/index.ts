/**
 * ClawTab background service worker — TypeScript port (phase 3).
 * Architecture: perceive → agent thinks → act → perceive loop.
 *
 * Kept as a single file for now. The original background.js was broken into
 * ~14 section banners; those are preserved as comment dividers here. A module
 * split can come in a later pass after the React migration settles — at that
 * point every function here has stable call sites in the sidebar and content
 * script, and refactoring is a safer mechanical move.
 */

import type { CapturedElement, PickedElement } from '@/shared/types/picker';
import type { ChatMessage, ClawtabCmd, ClawtabResult } from '@/shared/types/protocol';
import type {
  DiagLogEntry,
  LogLevel,
  LogSource,
  LoopHistoryStep,
  LoopSnapshot,
  LoopStatus,
  StatusSnapshot,
} from '@/shared/types/state';
import type {
  BasicResponse,
  ContentToBackgroundMessage,
  SidebarToBackgroundMessage,
  StatusUpdateBroadcast,
} from '@/shared/types/messages';

// ═══════════════════════════════════════════════════════
// SECTION 1: Constants
// ═══════════════════════════════════════════════════════

const VERSION = '3.0.0';
const POLL_IDLE_MS = 3000;
const POLL_MAX_MS = 30000;
const CMD_EXPIRE_MS = 180_000; // 3 min
const ACT_TIMEOUT = 20_000;

// ═══════════════════════════════════════════════════════
// SECTION 2: State
// ═══════════════════════════════════════════════════════

interface DeviceIdentity {
  id: string;
  publicKeyRaw: string;
  keyPair: CryptoKeyPair;
}

interface LoopState {
  status: LoopStatus;
  goal: string;
  agentId: string;
  cmdId: string | null;
  taskId: string | null;
  tabId: number | null;
  stepIndex: number;
  history: LoopHistoryStep[];
  lastScreenshot: string | null;
  lastUrl: string;
  lastTitle: string;
  statusText: string;
  errorMsg: string;
  startedAt: number | null;
  processedCmds: Set<string>;
}

interface BackgroundState {
  ws: WebSocket | null;
  wsUrl: string;
  wsToken: string;
  wsConnected: boolean;
  pairingPending: boolean;
  wsReconnectDelay: number;
  wsReconnectTimer: ReturnType<typeof setTimeout> | null;
  wsReconnectCount: number;
  wsGaveUp: boolean;
  wsManualDisconnect: boolean;
  wsDisconnectTimer: ReturnType<typeof setTimeout> | null;
  wsPendingConnectId: string | null;
  wsPendingNonce: string | null;

  browserId: string;
  deviceIdentity: DeviceIdentity | null;

  sessionKey: string;
  sessionExists: boolean;
  pollTimer: ReturnType<typeof setTimeout> | null;
  pollInterval: number;
  pollBackoff: number;
  pollPaused: boolean;
  lastSeenMsgId: string | null;

  loop: LoopState;

  tabCount: number;
  lastCmd: string;

  handshakeInFlight: boolean;
  logs: DiagLogEntry[];
  logPersistTimer: ReturnType<typeof setTimeout> | null;
  processedPersistTimer: ReturnType<typeof setTimeout> | null;
}

const S: BackgroundState = {
  ws: null,
  wsUrl: '',
  wsToken: '',
  wsConnected: false,
  pairingPending: false,
  wsReconnectDelay: 1000,
  wsReconnectTimer: null,
  wsReconnectCount: 0,
  wsGaveUp: false,
  wsManualDisconnect: false,
  wsDisconnectTimer: null,
  wsPendingConnectId: null,
  wsPendingNonce: null,

  browserId: '',
  deviceIdentity: null,

  sessionKey: '',
  sessionExists: false,
  pollTimer: null,
  pollInterval: POLL_IDLE_MS,
  pollBackoff: POLL_IDLE_MS,
  pollPaused: false,
  lastSeenMsgId: null,

  loop: {
    status: 'idle',
    goal: '',
    agentId: '',
    cmdId: null,
    taskId: null,
    tabId: null,
    stepIndex: 0,
    history: [],
    lastScreenshot: null,
    lastUrl: '',
    lastTitle: '',
    statusText: '',
    errorMsg: '',
    startedAt: null,
    processedCmds: new Set(),
  },

  tabCount: 0,
  lastCmd: '',

  handshakeInFlight: false,
  logs: [],
  logPersistTimer: null,
  processedPersistTimer: null,
};

// ═══════════════════════════════════════════════════════
// SECTION 2.5: Diagnostic logger
// ═══════════════════════════════════════════════════════

const LOG_CAP = 500;
const LOG_DATA_MAX_CHARS = 600;

async function loadLogs(): Promise<void> {
  try {
    const { diag_logs } = (await chrome.storage.local.get('diag_logs')) as {
      diag_logs?: DiagLogEntry[];
    };
    const stored = Array.isArray(diag_logs) ? diag_logs : [];
    S.logs = stored.concat(S.logs || []).slice(-LOG_CAP);
  } catch {
    /* keep S.logs */
  }
}

// processedCmds is the cmdId dedup set. Without persistence, every SW restart
// (Chrome MV3 kills idle SWs aggressively — default 30s) would re-process any
// clawtab_cmd still sitting in chat.history, running perceive/act again on
// the user's currently-active tab. Users see it as "tab switches keep
// re-sending data to the agent" because replayed perceives capture whatever
// tab is active at restart time, not the tab at original cmd time.
const PROCESSED_CMDS_CAP = 300;

async function loadProcessedCmds(): Promise<void> {
  try {
    const { processed_cmds } = (await chrome.storage.local.get('processed_cmds')) as {
      processed_cmds?: string[];
    };
    if (Array.isArray(processed_cmds)) {
      for (const id of processed_cmds) S.loop.processedCmds.add(id);
    }
  } catch {
    /* keep empty set */
  }
}

function persistProcessedCmdsSoon(): void {
  if (S.processedPersistTimer) return;
  S.processedPersistTimer = setTimeout(() => {
    S.processedPersistTimer = null;
    const arr = Array.from(S.loop.processedCmds).slice(-PROCESSED_CMDS_CAP);
    chrome.storage.local.set({ processed_cmds: arr }).catch(() => {});
  }, 250);
}

function persistLogsSoon(): void {
  if (S.logPersistTimer) return;
  S.logPersistTimer = setTimeout(() => {
    S.logPersistTimer = null;
    chrome.storage.local.set({ diag_logs: S.logs }).catch(() => {});
  }, 250);
}

function safeSerialize(data: unknown): string | undefined {
  if (data === undefined || data === null) return undefined;
  try {
    const seen = new WeakSet<object>();
    const str = JSON.stringify(data, (_key, v: unknown) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v as object)) return '[circular]';
        seen.add(v as object);
      }
      if (typeof v === 'string' && v.length > LOG_DATA_MAX_CHARS) {
        return (
          v.slice(0, LOG_DATA_MAX_CHARS) + `…(+${v.length - LOG_DATA_MAX_CHARS} chars)`
        );
      }
      return v;
    });
    return str.length > LOG_DATA_MAX_CHARS * 2
      ? str.slice(0, LOG_DATA_MAX_CHARS * 2) + '…'
      : str;
  } catch {
    return String(data);
  }
}

function logEvent(level: LogLevel, src: LogSource, msg: string, data?: unknown): void {
  const entry: DiagLogEntry = {
    t: Date.now(),
    level: level || 'info',
    src: src || 'bg',
    msg: String(msg == null ? '' : msg),
  };
  const ser = safeSerialize(data);
  if (ser !== undefined) entry.data = ser;

  S.logs.push(entry);
  if (S.logs.length > LOG_CAP) S.logs.splice(0, S.logs.length - LOG_CAP);
  persistLogsSoon();

  const line = `[${entry.src}] ${entry.msg}`;
  if (entry.level === 'error') console.error(line, data ?? '');
  else if (entry.level === 'warn') console.warn(line, data ?? '');
  else console.log(line, data ?? '');
}

function redactConfig(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj };
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (/token|secret|password|key/i.test(k) && typeof v === 'string' && v) {
      out[k] = v.length > 8
        ? `${v.slice(0, 4)}…${v.slice(-2)} (len=${v.length})`
        : `***(len=${v.length})`;
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════
// SECTION 3: Icon
// ═══════════════════════════════════════════════════════

type IconState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'perceiving'
  | 'thinking'
  | 'acting'
  | 'done'
  | 'failed'
  | 'cancelled';

const ICON_COLORS: Record<IconState, string> = {
  idle: '#94a3b8',
  connecting: '#f59e0b',
  connected: '#6366f1',
  perceiving: '#3b82f6',
  thinking: '#8b5cf6',
  acting: '#22c55e',
  done: '#6366f1',
  failed: '#ef4444',
  cancelled: '#94a3b8',
};

function drawIcon(state: IconState): void {
  if (state === 'idle' || state === 'connected' || state === 'done') {
    chrome.action.setIcon({
      path: {
        16: 'icons/icon16.png',
        48: 'icons/icon48.png',
        128: 'icons/icon128.png',
      },
    });
    return;
  }
  const color = ICON_COLORS[state] || ICON_COLORS.idle;
  const sizes = [16, 48, 128];
  const imageData: Record<number, ImageData> = {};
  for (const sz of sizes) {
    const c = new OffscreenCanvas(sz, sz);
    const ctx = c.getContext('2d');
    if (!ctx) continue;
    const r = sz * 0.22;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(sz - r, 0);
    ctx.quadraticCurveTo(sz, 0, sz, r);
    ctx.lineTo(sz, sz - r);
    ctx.quadraticCurveTo(sz, sz, sz - r, sz);
    ctx.lineTo(r, sz);
    ctx.quadraticCurveTo(0, sz, 0, sz - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.floor(sz * 0.5)}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('C', sz / 2, sz / 2 + sz * 0.02);
    imageData[sz] = ctx.getImageData(0, 0, sz, sz);
  }
  chrome.action.setIcon({ imageData });
}

// ═══════════════════════════════════════════════════════
// SECTION 4: Broadcast to sidebar
// ═══════════════════════════════════════════════════════

function broadcast(msg: unknown): void {
  chrome.runtime.sendMessage(msg).catch(() => {});
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id && tab.url && !tab.url.startsWith('chrome')) {
        chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
      }
    }
  });
}

function loopSnapshot(): LoopSnapshot {
  return {
    status: S.loop.status,
    goal: S.loop.goal,
    agentId: S.loop.agentId,
    stepIndex: S.loop.stepIndex,
    history: S.loop.history.slice(-8),
    lastScreenshot: S.loop.lastScreenshot,
    lastUrl: S.loop.lastUrl,
    lastTitle: S.loop.lastTitle,
    statusText: S.loop.statusText,
    errorMsg: S.loop.errorMsg,
    startedAt: S.loop.startedAt,
  };
}

function statusPayload(): StatusSnapshot {
  return {
    wsConnected: S.wsConnected,
    pairingPending: S.pairingPending,
    reconnecting: !S.wsConnected && !!S.wsUrl && !S.pairingPending,
    gaveUp: S.wsGaveUp || false,
    deviceId: S.deviceIdentity?.id || '',
    browserId: S.browserId,
    wsUrl: S.wsUrl,
    tabCount: S.tabCount,
    lastCmd: S.lastCmd,
    loop: loopSnapshot(),
  };
}

function broadcastStatus(): void {
  const msg: StatusUpdateBroadcast = {
    type: 'status_update',
    ...statusPayload(),
  };
  broadcast(msg);
}

function setLoopStatus(
  status: LoopStatus,
  statusText: string,
  extra: Partial<LoopState> = {},
): void {
  S.loop.status = status;
  S.loop.statusText = statusText || '';
  Object.assign(S.loop, extra);
  const iconState: IconState = (['perceiving', 'thinking', 'acting'] as const).includes(
    status as 'perceiving' | 'thinking' | 'acting',
  )
    ? (status as 'perceiving' | 'thinking' | 'acting')
    : S.wsConnected
      ? 'connected'
      : 'idle';
  drawIcon(iconState);
  broadcastStatus();
}

// ═══════════════════════════════════════════════════════
// SECTION 5: Device Identity
// ═══════════════════════════════════════════════════════

const IDB = { name: 'clawtab-v2', version: 1, store: 'device' } as const;

function openIDB(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB.name, IDB.version);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(IDB.store)) {
        r.result.createObjectStore(IDB.store);
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function idbGet<T = unknown>(key: string): Promise<T | undefined> {
  return openIDB().then(
    (db) =>
      new Promise<T | undefined>((res, rej) => {
        const r = db.transaction(IDB.store, 'readonly').objectStore(IDB.store).get(key);
        r.onsuccess = () => {
          db.close();
          res(r.result as T | undefined);
        };
        r.onerror = () => rej(r.error);
      }),
  );
}

function idbSet(key: string, val: unknown): Promise<void> {
  return openIDB().then(
    (db) =>
      new Promise<void>((res, rej) => {
        const r = db
          .transaction(IDB.store, 'readwrite')
          .objectStore(IDB.store)
          .put(val, key);
        r.onsuccess = () => {
          db.close();
          res();
        };
        r.onerror = () => rej(r.error);
      }),
  );
}

function b64url(ab: ArrayBuffer): string {
  let s = '';
  new Uint8Array(ab).forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface SavedDevice {
  version: 1;
  deviceId: string;
  publicKeyRaw: string;
  jwkPublic: JsonWebKey;
  jwkPrivate: JsonWebKey;
}

async function loadOrCreateDevice(): Promise<DeviceIdentity | null> {
  try {
    const saved = await idbGet<SavedDevice>('device');
    if (saved?.version === 1) {
      const priv = await crypto.subtle.importKey(
        'jwk',
        saved.jwkPrivate,
        { name: 'Ed25519' },
        true,
        ['sign'],
      );
      const pub = await crypto.subtle.importKey(
        'jwk',
        saved.jwkPublic,
        { name: 'Ed25519' },
        true,
        ['verify'],
      );
      return {
        id: saved.deviceId,
        publicKeyRaw: saved.publicKeyRaw,
        keyPair: { privateKey: priv, publicKey: pub },
      };
    }
    const kp = (await crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
    const pub = spki.slice(12);
    const pubRaw = b64url(pub);
    const hash = await crypto.subtle.digest('SHA-256', pub);
    const deviceId = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const jwkPub = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const jwkPriv = await crypto.subtle.exportKey('jwk', kp.privateKey);
    await idbSet('device', {
      version: 1,
      deviceId,
      publicKeyRaw: pubRaw,
      jwkPublic: jwkPub,
      jwkPrivate: jwkPriv,
    });
    return { id: deviceId, publicKeyRaw: pubRaw, keyPair: kp };
  } catch (e) {
    console.warn('[ClawTab] device identity error:', e);
    return null;
  }
}

interface SignConnectArgs {
  token: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  nonce: string;
}

async function signConnect(
  dev: DeviceIdentity,
  { token, role, scopes, signedAtMs, nonce }: SignConnectArgs,
) {
  const parts = [
    'v2',
    dev.id,
    'openclaw-control-ui',
    'webchat',
    role,
    scopes.join(','),
    String(signedAtMs),
    token || '',
    nonce,
  ];
  const sig = await crypto.subtle.sign(
    'Ed25519',
    dev.keyPair.privateKey,
    new TextEncoder().encode(parts.join('|')),
  );
  return {
    id: dev.id,
    publicKey: dev.publicKeyRaw,
    signature: b64url(sig),
    signedAt: signedAtMs,
    nonce,
  };
}

// ═══════════════════════════════════════════════════════
// SECTION 6: WebSocket
// ═══════════════════════════════════════════════════════

const SCOPES = ['operator.read', 'operator.write'];

interface PendingReq {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingReqs = new Map<string, PendingReq>();

interface WsEnvelope {
  type?: 'res' | 'event' | 'req';
  id?: string;
  event?: string;
  ok?: boolean;
  payload?: Record<string, unknown> & {
    code?: string;
    nonce?: string;
    auth?: { deviceToken?: string };
  };
  error?: unknown;
}

function wsSend(data: unknown): boolean {
  if (S.ws?.readyState === WebSocket.OPEN) {
    S.ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

function wsRequest<T extends Record<string, unknown> = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!S.wsConnected || !S.ws) {
      reject(new Error('not connected'));
      return;
    }
    const id =
      method.replace(/\./g, '_') +
      '-' +
      Date.now() +
      '-' +
      Math.random().toString(36).slice(2, 6);
    const timer = setTimeout(() => {
      pendingReqs.delete(id);
      reject(new Error(`Timeout: ${method}`));
    }, timeoutMs);
    pendingReqs.set(id, {
      resolve: resolve as (payload: Record<string, unknown>) => void,
      reject,
      timer,
    });
    wsSend({ type: 'req', id, method, params });
  });
}

function resolvePending(id: string, msg: WsEnvelope): void {
  const p = pendingReqs.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pendingReqs.delete(id);
  if (msg.ok) {
    p.resolve(msg.payload || {});
  } else {
    const errObj = (msg.error ?? msg.payload) as unknown;
    const errMsg =
      typeof errObj === 'object' && errObj !== null
        ? ((errObj as { message?: string; error?: string }).message ||
          (errObj as { error?: string }).error ||
          JSON.stringify(errObj))
        : typeof errObj === 'string'
          ? errObj
          : 'failed';
    const errCode =
      typeof errObj === 'object' && errObj !== null
        ? ((errObj as { code?: string; errorCode?: string }).code ||
          (errObj as { errorCode?: string }).errorCode ||
          '')
        : '';
    console.warn(
      '[ClawTab] wsReq failed:',
      id.split('-')[0],
      '| msg:',
      errMsg,
      '| code:',
      errCode,
    );
    p.reject(Object.assign(new Error(errMsg), { code: errCode }));
  }
}

async function wsConnect(url: string, token: string, browserId: string): Promise<void> {
  if (
    S.ws &&
    S.ws.readyState === WebSocket.CONNECTING &&
    S.wsUrl === url &&
    S.wsToken === token
  ) {
    logEvent('info', 'bg', 'wsConnect skipped (already CONNECTING to same endpoint)');
    return;
  }
  wsDisconnect();
  S.wsUrl = url;
  S.wsToken = token;
  S.browserId = browserId;
  S.sessionKey = `agent:main:clawtab-${browserId}`;
  drawIcon('connecting');
  broadcastStatus();
  logEvent('info', 'bg', 'wsConnect →', {
    url,
    browserId,
    sessionKey: S.sessionKey,
    retry: S.wsReconnectCount,
  });

  try {
    S.ws = new WebSocket(url);
  } catch (e) {
    logEvent('error', 'bg', 'WebSocket constructor threw', {
      error: (e as Error).message,
    });
    wsScheduleReconnect();
    return;
  }

  S.ws.onopen = async () => {
    logEvent('info', 'bg', 'ws onopen — sending initial connect req');
    const cid = 'connect-' + Date.now();
    S.wsPendingConnectId = cid;
    S.wsPendingNonce = null;
    const stored = (await chrome.storage.local.get(['deviceToken'])) as {
      deviceToken?: string;
    };
    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'openclaw-control-ui',
        version: '1.71.3',
        platform: 'browser_extension',
        mode: 'webchat',
      },
      role: 'operator',
      scopes: SCOPES,
      caps: [],
      commands: [],
      permissions: {},
      auth: stored.deviceToken ? { token, deviceToken: stored.deviceToken } : { token },
      locale: 'zh-CN',
      userAgent: `clawtab/${VERSION}${browserId ? ' (' + browserId + ')' : ''}`,
    };
    wsSend({ type: 'req', id: cid, method: 'connect', params });
  };

  S.ws.onmessage = async (ev: MessageEvent<string>) => {
    let msg: WsEnvelope;
    try {
      msg = JSON.parse(ev.data) as WsEnvelope;
    } catch {
      return;
    }

    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      S.wsPendingNonce = msg.payload?.nonce || null;
      logEvent('info', 'bg', 'connect.challenge received', {
        hasIdentity: !!S.deviceIdentity,
        hasNonce: !!S.wsPendingNonce,
      });
      if (S.deviceIdentity && S.wsPendingNonce && S.wsPendingConnectId) {
        const role = 'operator';
        const scopes = SCOPES;
        const signedAtMs = Date.now();
        const device = await signConnect(S.deviceIdentity, {
          token: S.wsToken,
          role,
          scopes,
          signedAtMs,
          nonce: S.wsPendingNonce,
        });
        const stored = (await chrome.storage.local.get(['deviceToken'])) as {
          deviceToken?: string;
        };
        logEvent('info', 'bg', 'sending signed connect', {
          deviceIdPrefix: S.deviceIdentity.id?.slice(0, 8),
        });
        wsSend({
          type: 'req',
          id: S.wsPendingConnectId,
          method: 'connect',
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: 'openclaw-control-ui',
              version: '1.71.3',
              platform: 'browser_extension',
              mode: 'webchat',
            },
            role,
            scopes,
            caps: [],
            commands: [],
            permissions: {},
            auth: stored.deviceToken
              ? { token: S.wsToken, deviceToken: stored.deviceToken }
              : { token: S.wsToken },
            device,
            locale: 'zh-CN',
            userAgent: `clawtab/${VERSION}${S.browserId ? ' (' + S.browserId + ')' : ''}`,
          },
        });
      } else {
        logEvent(
          'warn',
          'bg',
          'connect.challenge: cannot sign — missing deviceIdentity/nonce/connectId',
        );
      }
      return;
    }

    if (msg.type === 'res' && msg.id === S.wsPendingConnectId) {
      S.wsPendingConnectId = null;
      if (msg.ok) {
        S.wsConnected = true;
        S.pairingPending = false;
        S.wsReconnectDelay = 1000;
        S.wsReconnectCount = 0;
        S.wsGaveUp = false;
        if (S.wsDisconnectTimer) clearTimeout(S.wsDisconnectTimer);
        S.wsDisconnectTimer = null;
        if (S.wsReconnectTimer) clearTimeout(S.wsReconnectTimer);
        const dt = msg.payload?.auth?.deviceToken;
        if (dt) {
          await chrome.storage.local.set({ deviceToken: dt });
          logEvent('info', 'bg', 'deviceToken saved', { prefix: dt.slice(0, 8) + '…' });
        }
        logEvent('info', 'bg', 'connect.ok', {
          payloadKeys: Object.keys(msg.payload || {}),
        });
        drawIcon('connected');
        broadcastStatus();
        const isNewSession = await ensureSession();
        await syncLastSeenId();
        logEvent('info', 'bg', 'session ready', {
          isNewSession,
          lastSeenMsgId: S.lastSeenMsgId,
        });
        startPolling();
        reportTabs();
        const hsKey = `hs_${S.sessionKey}`;
        if (isNewSession) {
          S.lastSeenMsgId = null;
          await chrome.storage.local.remove([`lsid_${S.sessionKey}`]);
        }
        const hsFlag = await chrome.storage.local.get([hsKey]);
        if (!hsFlag[hsKey] && !S.lastSeenMsgId) {
          logEvent('info', 'bg', 'handshake gate: sending', {
            alreadySent: false,
            hasLastSeen: false,
          });
          await sendHandshake();
        } else {
          logEvent('info', 'bg', 'handshake gate: skipped', {
            alreadySent: !!hsFlag[hsKey],
            hasLastSeen: !!S.lastSeenMsgId,
          });
        }
      } else {
        const code = msg.payload?.code || '';
        logEvent('warn', 'bg', 'connect failed', { code, payload: msg.payload });
        if (code === 'NOT_PAIRED') {
          S.pairingPending = true;
          if (S.wsReconnectTimer) clearTimeout(S.wsReconnectTimer);
          drawIcon('connecting');
          broadcastStatus();
          S.wsReconnectTimer = setTimeout(() => {
            if (S.pairingPending) wsConnect(S.wsUrl, S.wsToken, S.browserId);
          }, 5000);
        } else {
          wsScheduleReconnect();
        }
      }
      return;
    }

    if (msg.type === 'res' && msg.id) {
      resolvePending(msg.id, msg);
    }
  };

  S.ws.onerror = (e: Event) => {
    logEvent('warn', 'bg', 'ws onerror', {
      message: (e as ErrorEvent).message || '',
    });
  };

  S.ws.onclose = (ev: CloseEvent) => {
    logEvent('info', 'bg', 'ws onclose', { code: ev.code, reason: ev.reason || '' });
    S.ws = null;
    S.wsConnected = false;
    if (S.loop.status === 'acting' || S.loop.status === 'perceiving') {
      setLoopStatus('failed', 'Connection lost during task', {
        errorMsg: 'WebSocket disconnected',
      });
      if (S.loop.cmdId)
        sendResult({
          cmdId: S.loop.cmdId,
          ok: false,
          error: 'Connection lost',
          errorCode: 'DISCONNECTED',
        });
    }
    stopPolling();
    if (S.pairingPending) return;
    if (S.wsDisconnectTimer) clearTimeout(S.wsDisconnectTimer);
    S.wsDisconnectTimer = setTimeout(() => {
      if (!S.wsConnected && !S.pairingPending) {
        drawIcon(S.wsGaveUp ? 'idle' : 'connecting');
        broadcastStatus();
      }
    }, 1500);
    wsScheduleReconnect();
  };
}

function wsDisconnect(): void {
  if (S.wsReconnectTimer) clearTimeout(S.wsReconnectTimer);
  if (S.wsDisconnectTimer) clearTimeout(S.wsDisconnectTimer);
  stopPolling();
  if (S.ws) {
    S.ws.onclose = null;
    S.ws.onerror = null;
    S.ws.onmessage = null;
    try {
      S.ws.close();
    } catch {
      /* ignore */
    }
    S.ws = null;
  }
  S.wsConnected = false;
}

function wsScheduleReconnect(): void {
  if (!S.wsUrl || !S.wsToken) return;
  S.wsReconnectCount++;
  console.warn(
    '[ClawTab] wsScheduleReconnect | attempt #' +
      S.wsReconnectCount +
      ' | delay:' +
      S.wsReconnectDelay +
      'ms',
  );
  if (S.wsReconnectCount > 3) {
    S.wsGaveUp = true;
    S.wsUrl = '';
    S.wsToken = '';
    drawIcon('idle');
    broadcastStatus();
    console.warn('[ClawTab] 3 reconnect failures, giving up');
    return;
  }
  if (S.wsReconnectTimer) clearTimeout(S.wsReconnectTimer);
  S.wsReconnectTimer = setTimeout(
    () => wsConnect(S.wsUrl, S.wsToken, S.browserId),
    S.wsReconnectDelay,
  );
  S.wsReconnectDelay = Math.min(S.wsReconnectDelay * 2, 30_000);
}

// ═══════════════════════════════════════════════════════
// SECTION 7: Session & Polling
// ═══════════════════════════════════════════════════════

async function ensureSession(): Promise<boolean> {
  try {
    await wsRequest('sessions.create', { key: S.sessionKey, agentId: 'main' }, 8000);
    S.sessionExists = true;
    return true;
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code === 'SESSION_EXISTS' || err.message?.includes('exists')) {
      S.sessionExists = true;
      return false;
    }
    console.warn('[ClawTab] ensureSession failed (non-fatal):', err.message, '| code:', err.code);
    return false;
  }
}

async function syncLastSeenId(): Promise<void> {
  try {
    const saved = await chrome.storage.local.get([`lsid_${S.sessionKey}`]);
    if (saved[`lsid_${S.sessionKey}`]) {
      S.lastSeenMsgId = saved[`lsid_${S.sessionKey}`] as string;
      return;
    }
    const res = await wsRequest<{ messages?: ChatMessage[] }>(
      'chat.history',
      { sessionKey: S.sessionKey, limit: 50 },
      8000,
    );
    const msgs = res.messages || [];
    if (msgs.length > 0) {
      S.lastSeenMsgId = pickMsgId(msgs[msgs.length - 1]) || null;
      await saveLastSeenId();
    }
  } catch (e) {
    logEvent('warn', 'bg', 'syncLastSeenId failed', { error: (e as Error).message });
  }
}

async function saveLastSeenId(): Promise<void> {
  if (S.lastSeenMsgId)
    await chrome.storage.local.set({ [`lsid_${S.sessionKey}`]: S.lastSeenMsgId });
}

function startPolling(): void {
  stopPolling();
  S.pollInterval = POLL_IDLE_MS;
  S.pollBackoff = POLL_IDLE_MS;
  S.pollPaused = false;
  logEvent('info', 'bg', 'polling started', { interval: S.pollInterval });
  schedulePoll(0);
}
function stopPolling(): void {
  if (S.pollTimer) clearTimeout(S.pollTimer);
  S.pollTimer = null;
}
function schedulePoll(ms: number): void {
  if (S.pollTimer) clearTimeout(S.pollTimer);
  S.pollTimer = setTimeout(doPoll, ms);
}

// Extract a message's stable id. Some `chat.history` payloads keep the id only
// inside `__openclaw.id` and leave the top-level `id` missing — falling back to
// it lets `lastSeenMsgId` track the watermark correctly. Without this, polling
// either fast-forwards past commands or replays the entire history every tick.
function pickMsgId(m: ChatMessage): string | undefined {
  return m.id || m.__openclaw?.id;
}

// Concatenate all text blocks from a chat message. Gateway returns three
// shapes: `content: string`, `content: [{type:"text",text}, ...]`, and
// `blocks: [{type:"text",text}, ...]`. The historical bug here was looking
// only at `string` and `blocks`, never the `content` array — which is the
// dominant shape — so `clawtab_cmd` blocks embedded in array-form messages
// were never picked up by the polling loop and `perceive` never ran.
function pickMsgText(m: ChatMessage): string {
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join('');
  }
  if (Array.isArray(m.blocks)) {
    return m.blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join('');
  }
  return '';
}

async function doPoll(): Promise<void> {
  if (!S.wsConnected || S.pollPaused) return;
  try {
    const res = await wsRequest<{ messages?: ChatMessage[] }>(
      'chat.history',
      { sessionKey: S.sessionKey, limit: 20 },
      8000,
    );
    S.pollBackoff = POLL_IDLE_MS;
    const allMsgs = res.messages || [];
    const seenIdx = S.lastSeenMsgId
      ? allMsgs.findIndex((m) => pickMsgId(m) === S.lastSeenMsgId)
      : -1;
    if (seenIdx === -1 && S.lastSeenMsgId) {
      logEvent('warn', 'bg', 'doPoll: lastSeenMsgId slid out of window, fast-forwarding', {
        lastSeenMsgId: S.lastSeenMsgId,
        windowSize: allMsgs.length,
      });
      if (allMsgs.length > 0) {
        S.lastSeenMsgId = pickMsgId(allMsgs[allMsgs.length - 1]) || null;
        await saveLastSeenId();
      }
      schedulePoll(S.pollInterval);
      return;
    }
    const newMsgs = seenIdx >= 0 ? allMsgs.slice(seenIdx + 1) : allMsgs;
    for (const msg of newMsgs) {
      const msgId = pickMsgId(msg);
      S.lastSeenMsgId = msgId || S.lastSeenMsgId;
      await saveLastSeenId();
      if (msg.role !== 'assistant') continue;
      const text = pickMsgText(msg);
      if (!text) {
        // Diagnostic: an assistant msg with no extractable text usually means
        // the gateway is using a content shape we don't handle. The historical
        // bug here was content:[{type:"text",text:...}] silently producing "".
        logEvent('info', 'bg', 'doPoll: assistant msg has no text', {
          msgId,
          contentKind: typeof msg.content,
          contentArrayLen: Array.isArray(msg.content) ? msg.content.length : null,
          blockTypes: Array.isArray(msg.content)
            ? (msg.content as Array<{ type: string }>).map((b) => b.type).slice(0, 6)
            : null,
        });
        continue;
      }
      const match = text.match(/```json\s*([\s\S]*?)```/);
      if (!match) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(match[1]);
      } catch (e) {
        logEvent('warn', 'bg', 'clawtab_cmd JSON parse failed', {
          msgId,
          error: (e as Error).message,
          snippet: match[1]?.slice(0, 200),
        });
        continue;
      }
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed as { type?: string }).type === 'clawtab_cmd'
      ) {
        await handleCmd(parsed as ClawtabCmd);
      }
    }
    schedulePoll(S.pollInterval);
  } catch (e) {
    logEvent('warn', 'bg', 'doPoll chat.history failed, backing off', {
      error: (e as Error).message,
      backoff: Math.min(S.pollBackoff * 2, POLL_MAX_MS),
    });
    S.pollBackoff = Math.min(S.pollBackoff * 2, POLL_MAX_MS);
    schedulePoll(S.pollBackoff);
  }
}

// ═══════════════════════════════════════════════════════
// SECTION 8: Command dispatcher
// ═══════════════════════════════════════════════════════

async function handleCmd(cmd: ClawtabCmd): Promise<void> {
  const { cmdId, agentId, action, payload, issuedAt, timeout = CMD_EXPIRE_MS } = cmd;
  const t0 = Date.now();

  logEvent('info', 'bg', 'cmd received', {
    cmdId,
    action,
    agentId,
    payloadSummary: payload ? Object.keys(payload) : null,
  });

  if (S.loop.processedCmds.has(cmdId)) {
    logEvent('info', 'bg', 'cmd skipped (dedup)', { cmdId, action });
    return;
  }
  if (issuedAt && Date.now() - issuedAt > timeout) {
    logEvent('warn', 'bg', 'cmd expired', {
      cmdId,
      action,
      ageMs: Date.now() - issuedAt,
      timeout,
    });
    await sendResult({
      cmdId,
      ok: false,
      error: 'Command expired',
      errorCode: 'EXPIRED',
    });
    return;
  }
  if (['acting', 'perceiving'].includes(S.loop.status) && action !== 'cancel') {
    logEvent('warn', 'bg', 'cmd rejected BUSY', {
      cmdId,
      action,
      busyStatus: S.loop.status,
      goal: S.loop.goal,
    });
    await sendResult({
      cmdId,
      ok: false,
      error: `Browser is busy: ${S.loop.status} (task: ${S.loop.goal})`,
      errorCode: 'BUSY',
      busyStatus: S.loop.status,
    });
    return;
  }

  S.loop.processedCmds.add(cmdId);
  if (S.loop.processedCmds.size > PROCESSED_CMDS_CAP) {
    const first = S.loop.processedCmds.values().next().value;
    if (first) S.loop.processedCmds.delete(first);
  }
  persistProcessedCmdsSoon();

  S.lastCmd = action;
  S.loop.cmdId = cmdId;
  S.loop.agentId = agentId || '';
  S.pollPaused = true;

  try {
    switch (action) {
      case 'perceive':
        await handlePerceive(cmd);
        break;
      case 'act':
        await handleAct(cmd);
        break;
      case 'task_start':
        handleTaskStart(cmd);
        await sendResult({ cmdId, ok: true });
        break;
      case 'task_done':
        handleTaskDone(cmd);
        await sendResult({ cmdId, ok: true });
        break;
      case 'task_fail':
        handleTaskFail(cmd);
        await sendResult({ cmdId, ok: true });
        break;
      case 'cancel':
        await handleCancel(cmd);
        break;
      case 'capabilities':
        await handleCapabilities(cmd);
        break;
      default: {
        const _exhaustive: never = action;
        logEvent('warn', 'bg', 'cmd unknown action', { cmdId, action: _exhaustive });
        await sendResult({
          cmdId,
          ok: false,
          error: `Unknown action: ${String(action)}`,
          errorCode: 'UNKNOWN_ACTION',
        });
      }
    }
    logEvent('info', 'bg', 'cmd done', { cmdId, action, durationMs: Date.now() - t0 });
  } catch (e) {
    logEvent('error', 'bg', 'cmd threw uncaught', {
      cmdId,
      action,
      error: (e as Error).message,
      durationMs: Date.now() - t0,
    });
    throw e;
  } finally {
    S.pollPaused = false;
    schedulePoll(300);
  }
}

// ═══════════════════════════════════════════════════════
// SECTION 9: Task lifecycle
// ═══════════════════════════════════════════════════════

function handleTaskStart(cmd: Extract<ClawtabCmd, { action: 'task_start' }>): void {
  const { taskId, goal, agentId, tabId } = cmd.payload || {};
  S.loop.taskId = taskId || null;
  S.loop.goal = goal || '';
  S.loop.agentId = agentId || '';
  S.loop.tabId = tabId || null;
  S.loop.stepIndex = 0;
  S.loop.history = [];
  S.loop.startedAt = Date.now();
  S.loop.errorMsg = '';
  setLoopStatus('thinking', 'Starting task…');
}

function handleTaskDone(cmd: Extract<ClawtabCmd, { action: 'task_done' }>): void {
  const summary = cmd.payload?.summary || 'Task completed';
  pushHistory({
    op: 'done',
    desc: summary,
    status: 'done',
    durationMs: Date.now() - (S.loop.startedAt ?? Date.now()),
  });
  setLoopStatus('done', `✅ ${summary}`);
  setTimeout(() => {
    if (S.loop.status === 'done') {
      S.loop.status = 'idle';
      S.loop.goal = '';
      broadcastStatus();
    }
  }, 8000);
}

function handleTaskFail(cmd: Extract<ClawtabCmd, { action: 'task_fail' }>): void {
  const err = cmd.payload?.error || 'Task failed';
  setLoopStatus('failed', `❌ ${err}`, { errorMsg: err });
  setTimeout(() => {
    if (S.loop.status === 'failed') {
      S.loop.status = 'idle';
      S.loop.goal = '';
      broadcastStatus();
    }
  }, 10_000);
}

async function handleCancel(cmd: Extract<ClawtabCmd, { action: 'cancel' }>): Promise<void> {
  const wasRunning = ['acting', 'perceiving', 'thinking'].includes(S.loop.status);
  setLoopStatus('cancelled', 'Cancelled by user');
  setTimeout(() => {
    S.loop.status = 'idle';
    S.loop.goal = '';
    broadcastStatus();
  }, 5000);
  await sendResult({
    cmdId: cmd.cmdId,
    ok: true,
    data: { message: 'Task cancelled', wasRunning },
  });
}

async function handleCapabilities(
  cmd: Extract<ClawtabCmd, { action: 'capabilities' }>,
): Promise<void> {
  await sendResult({
    cmdId: cmd.cmdId,
    ok: true,
    data: {
      version: VERSION,
      protocolVersion: 1,
      actions: [
        'perceive',
        'act',
        'task_start',
        'task_done',
        'task_fail',
        'cancel',
        'capabilities',
      ],
      perceiveInclude: [
        'screenshot',
        'title',
        'url',
        'dom',
        'scroll_position',
        'all',
      ],
      ops: [
        'click',
        'fill',
        'fill_form',
        'clear',
        'navigate',
        'scroll',
        'scroll_by',
        'scroll_to_element',
        'press',
        'select',
        'hover',
        'wait',
        'wait_for',
        'wait_for_url',
        'get_text',
        'get_attr',
        'get_all_links',
        'get_article_text',
        'new_tab',
        'close_tab',
        'switch_tab',
        'list_tabs',
        'go_back',
        'go_forward',
        'screenshot_element',
        'eval',
      ],
      flags: {
        pierceShadow: 'click/fill/clear/get_text/hover/scroll_to_element',
        fillBatchField: 'fill_form',
        pressModifiers: 'press (e.g. "ctrl+a", "meta+shift+k")',
      },
      browser: {
        browserId: S.browserId,
        tabCount: S.tabCount,
      },
    },
  });
}

// ═══════════════════════════════════════════════════════
// SECTION 10: Perceive
// ═══════════════════════════════════════════════════════

async function handlePerceive(
  cmd: Extract<ClawtabCmd, { action: 'perceive' }>,
): Promise<void> {
  const { cmdId, payload } = cmd;
  // Default: give the agent title + url + dom + screenshot. The screenshot
  // is re-encoded via shrinkScreenshot() before being attached to the
  // clawtab_result, keeping its on-wire size to ~15–30KB (down from ~150KB
  // of the raw Chrome JPEG) so the agent's context doesn't blow up over a
  // multi-perceive task. Agents that want the raw capture can pass
  // `payload.include = ["all"]` which still goes through the shrinker — we
  // intentionally never send full-resolution JPEGs over chat.send.
  const include = payload?.include ?? ['screenshot', 'title', 'url', 'dom'];
  const targetTabId =
    payload?.tabId || S.loop.tabId || (await getActiveTabId()) || 0;
  logEvent('info', 'bg', 'perceive start', { cmdId, targetTabId, include });

  setLoopStatus('perceiving', 'Analyzing page…');
  const stepStart = Date.now();

  try {
    const tab = await chrome.tabs.get(targetTabId);
    logEvent('info', 'bg', 'perceive target tab', {
      tabId: targetTabId,
      url: tab.url,
      title: tab.title?.slice(0, 60),
    });
    const result: Record<string, unknown> = {
      url: tab.url,
      title: tab.title,
      tabId: targetTabId,
    };

    if (include.includes('screenshot') || include.includes('all')) {
      await chrome.tabs.update(targetTabId, { active: true });
      await new Promise((r) => setTimeout(r, 200));
      try {
        const raw = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: 'jpeg',
          quality: 80,
        });
        result.screenshot = await shrinkScreenshot(raw);
        S.loop.lastScreenshot = result.screenshot as string;
        logEvent('info', 'bg', 'perceive screenshot ok', {
          bytes: (result.screenshot as string | undefined)?.length || 0,
        });
      } catch (e) {
        logEvent('error', 'bg', 'perceive screenshot failed', {
          error: (e as Error).message,
          windowId: tab.windowId,
          tabUrl: tab.url,
        });
        throw e;
      }
    }

    if (include.includes('dom') || include.includes('all')) {
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: targetTabId },
          func: extractDOM,
        });
        const dom = res?.[0]?.result || {};
        result.dom = dom;
        const domAny = dom as {
          simplified?: unknown;
          interactive?: unknown[];
          title?: string;
        };
        logEvent('info', 'bg', 'perceive dom ok', {
          hasSimplified: !!domAny.simplified,
          interactiveCount: Array.isArray(domAny.interactive)
            ? domAny.interactive.length
            : 0,
          title: domAny.title?.slice(0, 40),
        });
      } catch (e) {
        logEvent('error', 'bg', 'perceive dom extraction failed', {
          error: (e as Error).message,
          tabUrl: tab.url,
        });
        throw e;
      }
    }

    if (include.includes('scroll_position')) {
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: targetTabId },
          world: 'MAIN',
          func: () => ({
            x: window.scrollX,
            y: window.scrollY,
            height: document.documentElement.scrollHeight,
          }),
        });
        result.scrollPosition = res?.[0]?.result || {};
      } catch (e) {
        logEvent('warn', 'bg', 'perceive scroll_position failed', {
          error: (e as Error).message,
        });
      }
    }

    S.loop.lastUrl = (result.url as string) || '';
    S.loop.lastTitle = (result.title as string) || '';
    S.loop.stepIndex++;

    pushHistory({
      op: 'perceive',
      desc: `Analyzed: ${tab.title?.slice(0, 40) || tab.url}`,
      status: 'done',
      durationMs: Date.now() - stepStart,
    });
    setLoopStatus('thinking', 'Thinking…');

    logEvent('info', 'bg', 'perceive done, sending result', {
      cmdId,
      durationMs: Date.now() - stepStart,
      keys: Object.keys(result),
    });
    await sendResult({ cmdId, ok: true, data: result });
  } catch (e) {
    const err = e as Error;
    logEvent('error', 'bg', 'perceive failed', {
      cmdId,
      error: err.message,
      durationMs: Date.now() - stepStart,
    });
    pushHistory({
      op: 'perceive',
      desc: 'Analyze failed',
      status: 'failed',
      durationMs: Date.now() - stepStart,
    });
    setLoopStatus(
      S.loop.status === 'idle' ? 'idle' : 'thinking',
      `Perceive failed: ${err.message}`,
    );
    await sendResult({
      cmdId,
      ok: false,
      error: err.message,
      errorCode: 'PERCEIVE_FAILED',
    });
  }
}

function extractDOM(): Record<string, unknown> {
  interface SimplifiedNode {
    tag: string;
    id?: string;
    class?: string;
    text?: string;
    interactive?: boolean;
    href?: string;
    type?: string;
    placeholder?: string;
    value?: string;
    visible?: boolean;
    children?: SimplifiedNode[];
  }
  function simplify(el: Element | null, depth = 0): SimplifiedNode | null {
    // Depth cap = 3 (was 4). One extra level roughly doubles node count on
    // large pages; 3 keeps the tree shallow enough that perceive results
    // stay under ~8KB for typical sites while still surfacing all the
    // interactive chrome. Pair with the interactive[] array below for
    // anything the agent actually needs to target.
    if (!el || depth > 3) return null;
    const tag = el.tagName?.toLowerCase();
    if (!tag || ['script', 'style', 'svg', 'noscript', 'head'].includes(tag)) return null;
    const node: SimplifiedNode = { tag };
    const id = (el as HTMLElement).id;
    if (id) node.id = id;
    const cls = Array.from(el.classList).slice(0, 3).join(' ');
    if (cls) node.class = cls;
    const text =
      el.childNodes.length === 1 && el.childNodes[0].nodeType === 3
        ? (el.textContent?.trim().slice(0, 80) ?? '')
        : '';
    if (text) node.text = text;
    if (['a', 'button', 'input', 'select', 'textarea'].includes(tag)) {
      const anyEl = el as HTMLAnchorElement & HTMLInputElement;
      node.interactive = true;
      if (anyEl.href) node.href = anyEl.href;
      if (anyEl.type) node.type = anyEl.type;
      if (anyEl.placeholder) node.placeholder = anyEl.placeholder;
      if (anyEl.value && tag !== 'input') node.value = String(anyEl.value).slice(0, 50);
      const h = el as HTMLElement;
      node.visible = !!(h.offsetWidth || h.offsetHeight || h.getClientRects().length);
    }
    const children = Array.from(el.children)
      .map((c) => simplify(c, depth + 1))
      .filter((v): v is SimplifiedNode => v !== null);
    if (children.length) node.children = children;
    return node;
  }
  const interactive = Array.from(
    document.querySelectorAll(
      'a,button,input,select,textarea,[role="button"],[onclick]',
    ),
  )
    .slice(0, 50)
    .map((el) => {
      const rect = el.getBoundingClientRect();
      const h = el as HTMLAnchorElement & HTMLInputElement;
      return {
        tag: el.tagName.toLowerCase(),
        id: h.id || null,
        text: el.textContent?.trim().slice(0, 60) || null,
        placeholder: h.placeholder || null,
        type: h.type || null,
        href: h.href || null,
        selector: h.id
          ? `#${h.id}`
          : h.className
            ? `.${h.className.split(' ')[0]}`
            : el.tagName.toLowerCase(),
        visible: rect.width > 0 && rect.height > 0,
      };
    })
    .filter((el) => el.visible);
  return {
    title: document.title,
    url: location.href,
    simplified: simplify(document.body),
    interactive,
    metaDescription:
      document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content || '',
  };
}

// ═══════════════════════════════════════════════════════
// SECTION 11: Act
// ═══════════════════════════════════════════════════════

async function handleAct(cmd: Extract<ClawtabCmd, { action: 'act' }>): Promise<void> {
  const { cmdId, payload } = cmd;
  const {
    tabId,
    op,
    target,
    value,
    fields,
    pierceShadow = false,
    waitAfter = 500,
    captureAfter = true,
    timeout = ACT_TIMEOUT,
  } = payload || ({} as NonNullable<typeof payload>);
  const targetTabId = tabId || S.loop.tabId || (await getActiveTabId()) || 0;

  const opDesc = describeOp(op, target, value);
  logEvent('info', 'bg', 'act start', {
    cmdId,
    op,
    targetTabId,
    target: typeof target === 'string' ? target.slice(0, 80) : target,
    value: typeof value === 'string' ? value.slice(0, 80) : value,
    pierceShadow,
    hasFields: !!fields,
    timeout,
  });
  setLoopStatus('acting', opDesc);
  const stepStart = Date.now();

  try {
    const result = (await Promise.race([
      executeAct(targetTabId, op, target, value, waitAfter, { fields, pierceShadow }),
      new Promise<never>((_res, rej) =>
        setTimeout(() => rej(new Error(`Act timeout: ${op}`)), timeout),
      ),
    ])) as Record<string, unknown>;

    if (captureAfter) {
      try {
        await new Promise((r) => setTimeout(r, 400));
        const tab = await chrome.tabs.get(targetTabId);
        const raw = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: 'jpeg',
          quality: 80,
        });
        result.screenshot = await shrinkScreenshot(raw);
        S.loop.lastScreenshot = result.screenshot as string;
        result.urlAfter = tab.url;
        result.titleAfter = tab.title;
        S.loop.lastUrl = tab.url || '';
        S.loop.lastTitle = tab.title || '';
      } catch (e) {
        logEvent('warn', 'bg', 'act post-screenshot failed', {
          error: (e as Error).message,
        });
      }
    }

    S.loop.stepIndex++;
    pushHistory({
      op: String(op),
      desc: opDesc,
      status: 'done',
      durationMs: Date.now() - stepStart,
    });
    setLoopStatus('thinking', 'Thinking…');
    logEvent('info', 'bg', 'act ok', {
      cmdId,
      op,
      durationMs: Date.now() - stepStart,
    });
    await sendResult({ cmdId, ok: true, data: result });
  } catch (e) {
    const err = e as Error;
    logEvent('error', 'bg', 'act failed', {
      cmdId,
      op,
      error: err.message,
      durationMs: Date.now() - stepStart,
    });
    pushHistory({
      op: String(op),
      desc: opDesc,
      status: 'failed',
      durationMs: Date.now() - stepStart,
      error: err.message,
    });
    setLoopStatus('thinking', `Act failed: ${err.message}`);
    await sendResult({
      cmdId,
      ok: false,
      error: err.message,
      errorCode: 'ACT_FAILED',
      op,
    });
  }
}

function describeOp(op: string, target: unknown, value: unknown): string {
  const t = target ? `"${String(target).slice(0, 30)}"` : null;
  const v = value ? `"${String(value).slice(0, 30)}"` : null;
  switch (op) {
    case 'click':
      return t ? `Clicking ${t}` : 'Clicking element';
    case 'fill':
      return t && v ? `Typing ${v} into ${t}` : 'Filling input';
    case 'fill_form':
      return 'Filling form';
    case 'clear':
      return t ? `Clearing ${t}` : 'Clearing input';
    case 'navigate':
      return v ? `Navigating to ${v}` : 'Navigating…';
    case 'scroll':
      return `Scrolling to (${target || 0}, ${value || 0})`;
    case 'scroll_by':
      return `Scrolling by (${target || 0}, ${value || 0})`;
    case 'scroll_to_element':
      return t ? `Scrolling to ${t}` : 'Scrolling to element';
    case 'press':
      return v ? `Pressing ${v}` : 'Pressing key';
    case 'select':
      return t ? `Selecting in ${t}` : 'Selecting option';
    case 'hover':
      return t ? `Hovering ${t}` : 'Hovering element';
    case 'wait':
      return `Waiting ${value || target || 1000}ms`;
    case 'wait_for':
      return t ? `Waiting for ${t}` : 'Waiting for element';
    case 'wait_for_url':
      return t ? `Waiting for URL ${t}` : 'Waiting for URL';
    case 'get_text':
      return t ? `Reading text from ${t}` : 'Reading text';
    case 'get_attr':
      return t ? `Reading ${v || 'attr'} from ${t}` : 'Reading attribute';
    case 'get_all_links':
      return 'Listing links';
    case 'get_article_text':
      return 'Reading article';
    case 'new_tab':
      return `Opening new tab${t ? ': ' + t : ''}`;
    case 'close_tab':
      return `Closing tab ${target || ''}`;
    case 'switch_tab':
      return t ? `Switching to tab ${t}` : 'Switching tab';
    case 'list_tabs':
      return 'Listing tabs';
    case 'go_back':
      return 'Going back';
    case 'go_forward':
      return 'Going forward';
    case 'screenshot_element':
      return t ? `Capturing ${t}` : 'Capturing element';
    case 'eval':
      return 'Running script';
    default:
      return op;
  }
}

async function executeAct(
  tabId: number,
  op: string,
  target: unknown,
  value: unknown,
  waitAfter: number,
  opts: {
    fields?: Record<string, string>;
    pierceShadow?: boolean;
  } = {},
): Promise<Record<string, unknown>> {
  const pierceShadow = !!opts.pierceShadow;
  switch (op) {
    case 'navigate': {
      await chrome.tabs.update(tabId, { url: String(value || target) });
      await waitForTabLoad(tabId, 15_000);
      return { op, navigatedTo: value || target };
    }
    case 'click': {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (sel: string, pierce: boolean) => {
          function findOne(root: Document | ShadowRoot, query: string): Element | null {
            const direct = root.querySelector(query);
            if (direct) return direct;
            if (!pierce) return null;
            const hosts = root.querySelectorAll('*');
            for (const h of hosts) {
              const sr = (h as HTMLElement & { shadowRoot?: ShadowRoot }).shadowRoot;
              if (sr) {
                const found = findOne(sr, query);
                if (found) return found;
              }
            }
            return null;
          }
          function findByText(query: string): Element | null {
            for (const e of document.querySelectorAll('*'))
              if (e.textContent?.trim() === query || e.getAttribute('aria-label') === query)
                return e as HTMLElement;
            return null;
          }
          const el = findOne(document, sel) || findByText(sel);
          if (!el) throw new Error(`Element not found: ${sel}`);
          (el as HTMLElement).click();
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        },
        args: [String(target), pierceShadow],
      });
      if (waitAfter) await new Promise((r) => setTimeout(r, waitAfter));
      return { op, clicked: target };
    }
    case 'fill': {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (sel: string, val: string, pierce: boolean) => {
          function findOne(root: Document | ShadowRoot, query: string): Element | null {
            const direct = root.querySelector(query);
            if (direct) return direct;
            if (!pierce) return null;
            for (const h of root.querySelectorAll('*')) {
              const sr = (h as HTMLElement & { shadowRoot?: ShadowRoot }).shadowRoot;
              if (sr) {
                const found = findOne(sr, query);
                if (found) return found;
              }
            }
            return null;
          }
          const el = findOne(document, sel) as HTMLInputElement | null;
          if (!el) throw new Error(`Element not found: ${sel}`);
          el.focus();
          el.value = val;
          ['input', 'change', 'keyup'].forEach((ev) =>
            el.dispatchEvent(new Event(ev, { bubbles: true })),
          );
        },
        args: [String(target), String(value || ''), pierceShadow],
      });
      if (waitAfter) await new Promise((r) => setTimeout(r, waitAfter));
      return { op, filled: target, value };
    }
    case 'fill_form': {
      // Batch fill for login / checkout / long forms. Avoids N separate
      // clawtab_cmd round trips — each is a ~300ms gateway RTT + polling tick.
      const fieldMap = opts.fields || {};
      const keys = Object.keys(fieldMap);
      if (keys.length === 0) {
        throw new Error('fill_form requires a non-empty payload.fields map');
      }
      const filled: Array<{ selector: string; ok: boolean; error?: string }> = [];
      for (const sel of keys) {
        const val = String(fieldMap[sel] ?? '');
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (s: string, v: string, pierce: boolean) => {
              function findOne(
                root: Document | ShadowRoot,
                query: string,
              ): Element | null {
                const direct = root.querySelector(query);
                if (direct) return direct;
                if (!pierce) return null;
                for (const h of root.querySelectorAll('*')) {
                  const sr = (h as HTMLElement & { shadowRoot?: ShadowRoot }).shadowRoot;
                  if (sr) {
                    const found = findOne(sr, query);
                    if (found) return found;
                  }
                }
                return null;
              }
              const el = findOne(document, s) as HTMLInputElement | null;
              if (!el) throw new Error(`Element not found: ${s}`);
              el.focus();
              el.value = v;
              ['input', 'change', 'keyup'].forEach((ev) =>
                el.dispatchEvent(new Event(ev, { bubbles: true })),
              );
            },
            args: [sel, val, pierceShadow],
          });
          filled.push({ selector: sel, ok: true });
        } catch (e) {
          filled.push({
            selector: sel,
            ok: false,
            error: (e as Error).message,
          });
        }
      }
      if (waitAfter) await new Promise((r) => setTimeout(r, waitAfter));
      return { op, filled, total: keys.length };
    }
    case 'clear': {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (sel: string, pierce: boolean) => {
          function findOne(root: Document | ShadowRoot, query: string): Element | null {
            const direct = root.querySelector(query);
            if (direct) return direct;
            if (!pierce) return null;
            for (const h of root.querySelectorAll('*')) {
              const sr = (h as HTMLElement & { shadowRoot?: ShadowRoot }).shadowRoot;
              if (sr) {
                const found = findOne(sr, query);
                if (found) return found;
              }
            }
            return null;
          }
          const el = findOne(document, sel) as HTMLInputElement | null;
          if (!el) throw new Error(`Element not found: ${sel}`);
          el.focus();
          el.value = '';
          ['input', 'change'].forEach((ev) =>
            el.dispatchEvent(new Event(ev, { bubbles: true })),
          );
        },
        args: [String(target), pierceShadow],
      });
      if (waitAfter) await new Promise((r) => setTimeout(r, waitAfter));
      return { op, cleared: target };
    }
    case 'press': {
      // Supports plain keys ("Enter", "Escape") and combos ("ctrl+a",
      // "meta+shift+k"). Combos parse the leading modifier tokens and
      // dispatch a KeyboardEvent with the right modifier flags set. Note:
      // DOM-level key dispatch reaches page-level JS listeners but cannot
      // trigger browser chrome shortcuts (Ctrl+T to open a new tab, etc.);
      // for those, use the dedicated op (new_tab/navigate/...).
      const raw = String(value || target || '');
      const parts = raw.split('+').map((s) => s.trim()).filter(Boolean);
      const modTokens = new Set(['ctrl', 'control', 'shift', 'alt', 'option', 'meta', 'cmd', 'command']);
      const modifiers = {
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
      };
      let mainKey = raw;
      for (const p of parts) {
        const lower = p.toLowerCase();
        if (modTokens.has(lower)) {
          if (lower === 'ctrl' || lower === 'control') modifiers.ctrlKey = true;
          else if (lower === 'shift') modifiers.shiftKey = true;
          else if (lower === 'alt' || lower === 'option') modifiers.altKey = true;
          else if (lower === 'meta' || lower === 'cmd' || lower === 'command')
            modifiers.metaKey = true;
        } else {
          mainKey = p;
        }
      }
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (
          key: string,
          mods: {
            ctrlKey: boolean;
            shiftKey: boolean;
            altKey: boolean;
            metaKey: boolean;
          },
        ) => {
          const el = document.activeElement || document.body;
          ['keydown', 'keypress', 'keyup'].forEach((ev) =>
            el.dispatchEvent(
              new KeyboardEvent(ev, {
                key,
                code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
                bubbles: true,
                cancelable: true,
                ...mods,
              }),
            ),
          );
        },
        args: [mainKey, modifiers],
      });
      if (waitAfter) await new Promise((r) => setTimeout(r, waitAfter));
      return { op, pressed: raw, mainKey, modifiers };
    }
    case 'select': {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (sel: string, val: string) => {
          const el = document.querySelector<HTMLSelectElement>(sel);
          if (!el) throw new Error(`Select not found: ${sel}`);
          el.value = val;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        },
        args: [String(target), String(value)],
      });
      return { op, selected: value };
    }
    case 'hover': {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (sel: string, pierce: boolean) => {
          function findOne(root: Document | ShadowRoot, query: string): Element | null {
            const direct = root.querySelector(query);
            if (direct) return direct;
            if (!pierce) return null;
            for (const h of root.querySelectorAll('*')) {
              const sr = (h as HTMLElement & { shadowRoot?: ShadowRoot }).shadowRoot;
              if (sr) {
                const found = findOne(sr, query);
                if (found) return found;
              }
            }
            return null;
          }
          const el = findOne(document, sel);
          if (!el) throw new Error(`Element not found: ${sel}`);
          ['mouseover', 'mouseenter', 'mousemove'].forEach((ev) =>
            el.dispatchEvent(new MouseEvent(ev, { bubbles: true })),
          );
        },
        args: [String(target), pierceShadow],
      });
      if (waitAfter) await new Promise((r) => setTimeout(r, waitAfter));
      return { op, hovered: target };
    }
    case 'scroll': {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (x: number, y: number) =>
          window.scrollTo({ left: x, top: y, behavior: 'smooth' }),
        args: [Number(target) || 0, Number(value) || 0],
      });
      await new Promise((r) => setTimeout(r, 600));
      return { op, scrolledTo: { x: Number(target) || 0, y: Number(value) || 0 } };
    }
    case 'scroll_by': {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (dx: number, dy: number) =>
          window.scrollBy({ left: dx, top: dy, behavior: 'smooth' }),
        args: [Number(target) || 0, Number(value) || 0],
      });
      await new Promise((r) => setTimeout(r, 600));
      return { op, scrolledBy: { x: Number(target) || 0, y: Number(value) || 0 } };
    }
    case 'scroll_to_element': {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (sel: string, block: ScrollLogicalPosition, pierce: boolean) => {
          function findOne(root: Document | ShadowRoot, query: string): Element | null {
            const direct = root.querySelector(query);
            if (direct) return direct;
            if (!pierce) return null;
            for (const h of root.querySelectorAll('*')) {
              const sr = (h as HTMLElement & { shadowRoot?: ShadowRoot }).shadowRoot;
              if (sr) {
                const found = findOne(sr, query);
                if (found) return found;
              }
            }
            return null;
          }
          const el = findOne(document, sel);
          if (!el) throw new Error(`Element not found: ${sel}`);
          el.scrollIntoView({ behavior: 'smooth', block: block || 'center' });
        },
        args: [String(target), (value as ScrollLogicalPosition) || 'center', pierceShadow],
      });
      await new Promise((r) => setTimeout(r, 700));
      return { op, scrolledTo: target };
    }
    case 'wait': {
      const ms = Number(value) || Number(target) || 1000;
      await new Promise((r) => setTimeout(r, ms));
      return { op, waited: ms };
    }
    case 'wait_for': {
      const maxMs = Number(value) || 10_000;
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        const res = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: (sel: string) => !!document.querySelector(sel),
          args: [String(target)],
        });
        if (res?.[0]?.result) return { op, found: target, waitedMs: Date.now() - start };
        await new Promise((r) => setTimeout(r, 300));
      }
      throw new Error(`wait_for timeout: "${String(target)}" not found within ${maxMs}ms`);
    }
    case 'wait_for_url': {
      // Waits for the active tab's URL to match a glob-ish pattern. Patterns
      // support `*` (any substring) and `**` (any multi-segment substring).
      // Use cases: "clicked Login, wait until we land on /dashboard".
      const pattern = String(target || '');
      if (!pattern) throw new Error('wait_for_url requires target pattern');
      const maxMs = Number(value) || 15_000;
      const reSource = pattern
        .split('**')
        .map((seg) =>
          seg
            .split('*')
            .map((p) => p.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
            .join('.*'),
        )
        .join('.*');
      const re = new RegExp('^' + reSource + '$');
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.url && re.test(tab.url)) {
            return { op, url: tab.url, waitedMs: Date.now() - start };
          }
        } catch {
          /* tab may be transitioning */
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error(`wait_for_url timeout: "${pattern}" not reached within ${maxMs}ms`);
    }
    case 'get_text': {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (sel: string, pierce: boolean) => {
          function findOne(root: Document | ShadowRoot, query: string): Element | null {
            const direct = root.querySelector(query);
            if (direct) return direct;
            if (!pierce) return null;
            for (const h of root.querySelectorAll('*')) {
              const sr = (h as HTMLElement & { shadowRoot?: ShadowRoot }).shadowRoot;
              if (sr) {
                const found = findOne(sr, query);
                if (found) return found;
              }
            }
            return null;
          }
          const el = findOne(document, sel) as (HTMLElement & HTMLInputElement) | null;
          if (!el) throw new Error(`Element not found: ${sel}`);
          return el.textContent?.trim() || el.value || el.innerText || '';
        },
        args: [String(target), pierceShadow],
      });
      const text = res?.[0]?.result;
      if (text === undefined || text === null)
        throw new Error(`Could not read text from: ${String(target)}`);
      return { op, selector: target, text };
    }
    case 'get_all_links': {
      const maxCount = Number(value) || 500;
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (selFilter: string, limit: number) => {
          const q = selFilter && selFilter.trim() ? selFilter : 'a[href]';
          const out: Array<{
            href: string;
            text: string;
            title: string | null;
            visible: boolean;
          }> = [];
          for (const el of Array.from(document.querySelectorAll<HTMLAnchorElement>(q))) {
            if (out.length >= limit) break;
            const rect = el.getBoundingClientRect();
            out.push({
              href: el.href,
              text: (el.textContent || '').trim().slice(0, 160),
              title: el.getAttribute('title'),
              visible: rect.width > 0 && rect.height > 0,
            });
          }
          return out;
        },
        args: [String(target || ''), maxCount],
      });
      return { op, links: res?.[0]?.result ?? [] };
    }
    case 'get_article_text': {
      // Heuristic-based article extraction without pulling a readability dep
      // into the service worker. Prefers <article>, then <main>, then the
      // densest-text container. Strips nav/aside/footer/script/style text.
      const maxChars = Number(value) || 20_000;
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (limit: number) => {
          const SKIP = new Set([
            'SCRIPT',
            'STYLE',
            'NAV',
            'ASIDE',
            'FOOTER',
            'HEADER',
            'FORM',
            'BUTTON',
          ]);
          function visibleText(root: Element): string {
            const parts: string[] = [];
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let node: Node | null = walker.nextNode();
            while (node) {
              const parent = node.parentElement;
              if (parent && !SKIP.has(parent.tagName)) {
                const txt = node.nodeValue?.trim();
                if (txt) parts.push(txt);
              }
              node = walker.nextNode();
            }
            return parts.join('\n');
          }
          const article = document.querySelector('article') || document.querySelector('main');
          let chosen: Element = article || document.body;
          if (!article) {
            // Pick the element with the longest concatenated paragraph text.
            let bestLen = 0;
            for (const el of Array.from(document.querySelectorAll('section, div'))) {
              const ps = el.querySelectorAll('p');
              if (ps.length < 2) continue;
              let len = 0;
              for (const p of Array.from(ps)) len += (p.textContent || '').length;
              if (len > bestLen) {
                bestLen = len;
                chosen = el;
              }
            }
          }
          const text = visibleText(chosen).slice(0, limit);
          return {
            title: document.title,
            url: location.href,
            text,
            truncated: text.length >= limit,
          };
        },
        args: [maxChars],
      });
      return { op, ...(res?.[0]?.result as object) };
    }
    case 'get_attr': {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (sel: string, attr: string) => {
          const el = document.querySelector(sel) as HTMLElement & Record<string, unknown>;
          if (!el) throw new Error(`Element not found: ${sel}`);
          return el.getAttribute(attr) ?? el[attr] ?? null;
        },
        args: [String(target), String(value || 'href')],
      });
      return {
        op,
        selector: target,
        attr: value || 'href',
        attrValue: res?.[0]?.result,
      };
    }
    case 'new_tab': {
      const tab = await chrome.tabs.create({
        url: String(target || value || 'about:blank'),
        active: true,
      });
      if ((target || value) && tab.id) await waitForTabLoad(tab.id, 15_000);
      S.loop.tabId = tab.id ?? null;
      return { op, tabId: tab.id, url: target || value };
    }
    case 'close_tab': {
      const closeId = Number(target) || tabId;
      await chrome.tabs.remove(closeId);
      return { op, closedTabId: closeId };
    }
    case 'switch_tab': {
      let switchId = Number(target);
      if (!switchId || isNaN(switchId)) {
        const tabs = await chrome.tabs.query({});
        const match = tabs.find(
          (t) => t.url?.includes(String(target)) || t.title?.includes(String(target)),
        );
        if (!match) throw new Error(`No tab matching: ${String(target)}`);
        switchId = match.id!;
      }
      await chrome.tabs.update(switchId, { active: true });
      S.loop.tabId = switchId;
      const tab = await chrome.tabs.get(switchId);
      return { op, switchedToTabId: switchId, url: tab.url, title: tab.title };
    }
    case 'list_tabs': {
      // Full tab inventory for the agent. Without this, agents only see the
      // raw `tabCount` in status broadcasts and cannot reference specific
      // tabs ("switch to the github tab") without perceive roundtrips.
      const tabs = await chrome.tabs.query({});
      const cleaned = tabs
        .filter((t) => !!t.id)
        .map((t) => ({
          id: t.id!,
          windowId: t.windowId,
          url: t.url || '',
          title: (t.title || '').slice(0, 200),
          active: !!t.active,
          pinned: !!t.pinned,
          audible: !!t.audible,
          muted: !!t.mutedInfo?.muted,
          favIconUrl: t.favIconUrl,
        }));
      return { op, tabs: cleaned, total: cleaned.length };
    }
    case 'go_back': {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => window.history.back(),
      });
      await new Promise((r) => setTimeout(r, waitAfter || 800));
      return { op };
    }
    case 'go_forward': {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => window.history.forward(),
      });
      await new Promise((r) => setTimeout(r, waitAfter || 800));
      return { op };
    }
    case 'screenshot_element': {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (sel: string) => {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (!el) throw new Error(`Element not found: ${sel}`);
          el.scrollIntoView({ block: 'center' });
          const r = el.getBoundingClientRect();
          return {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
          };
        },
        args: [String(target)],
      });
      const rect = res?.[0]?.result;
      if (!rect) throw new Error('Could not get element bounds');
      await new Promise((r) => setTimeout(r, 400));
      const tab = await chrome.tabs.get(tabId);
      const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: 'jpeg',
        quality: 80,
      });
      return { op, screenshot, elementRect: rect, selector: target };
    }
    case 'eval': {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (code: string) => {
          try {
            // eslint-disable-next-line no-eval
            return { ok: true, value: eval(code) };
          } catch (e) {
            return { ok: false, error: (e as Error).message };
          }
        },
        args: [String(value || target)],
      });
      const r = res?.[0]?.result as { ok: boolean; value?: unknown; error?: string };
      if (!r?.ok) throw new Error(r?.error || 'eval failed');
      return {
        op,
        result:
          typeof r.value === 'object'
            ? JSON.stringify(r.value)
            : String(r.value ?? ''),
      };
    }
    default:
      throw new Error(`Unknown op: ${op}`);
  }
}

function waitForTabLoad(tabId: number, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(), maxMs);
    function listener(id: number, info: chrome.tabs.TabChangeInfo) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ═══════════════════════════════════════════════════════
// SECTION 12: Helpers
// ═══════════════════════════════════════════════════════

function pushHistory(entry: LoopHistoryStep): void {
  S.loop.history.push(entry);
  if (S.loop.history.length > 50) S.loop.history.shift();
}

async function getActiveTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function reportTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  S.tabCount = tabs.length;
  broadcastStatus();
}

function dataURLToBlob(dataURL: string): Blob {
  const [head, b64] = dataURL.split(',');
  const mimeMatch = head.match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function blobToDataURL(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((ab) => {
    const bytes = new Uint8Array(ab);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return `data:${blob.type};base64,${btoa(bin)}`;
  });
}

/**
 * Re-encode a Chrome `captureVisibleTab` JPEG at a lower resolution + quality
 * before shipping it to the agent. Chrome's native capture is tied to the tab
 * viewport (often 1920x1080+), which after base64 is ~150KB per snapshot; a
 * multi-step agent task with screenshots on each perceive easily crosses the
 * LLM 1M-token context window. Shrinking to a 1024px longest-edge + quality
 * 0.42 JPEG gives ~15–30KB on the wire while staying legible for the model.
 *
 * If decoding / re-encoding fails for any reason, fall back to the original
 * data URL rather than breaking perceive — an oversized screenshot is still
 * better than none.
 */
async function shrinkScreenshot(
  raw: string,
  maxDim = 1024,
  quality = 0.42,
): Promise<string> {
  try {
    const img = await createImageBitmap(dataURLToBlob(raw));
    let w = img.width;
    let h = img.height;
    if (Math.max(w, h) > maxDim) {
      if (w >= h) {
        h = Math.round((h * maxDim) / w);
        w = maxDim;
      } else {
        w = Math.round((w * maxDim) / h);
        h = maxDim;
      }
    }
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      img.close();
      return raw;
    }
    ctx.drawImage(img, 0, 0, w, h);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    img.close();
    return await blobToDataURL(out);
  } catch (e) {
    logEvent('warn', 'bg', 'shrinkScreenshot failed, using raw', {
      error: (e as Error).message,
      rawBytes: raw.length,
    });
    return raw;
  }
}

type SendResultInput = Omit<ClawtabResult, 'type' | 'browserId' | 'ts'>;

async function sendResult(result: SendResultInput): Promise<void> {
  const msg = JSON.stringify(
    {
      type: 'clawtab_result',
      ...result,
      browserId: S.browserId,
      ts: Date.now(),
    },
    null,
    2,
  );
  try {
    await wsRequest(
      'chat.send',
      {
        sessionKey: S.sessionKey,
        message: '```json\n' + msg + '\n```',
        deliver: false,
        idempotencyKey: crypto.randomUUID(),
      },
      8000,
    );
    logEvent('info', 'bg', 'sendResult delivered', {
      cmdId: result.cmdId,
      ok: result.ok,
      errorCode: result.errorCode,
    });
  } catch (e) {
    logEvent('error', 'bg', 'sendResult failed', {
      cmdId: result.cmdId,
      ok: result.ok,
      error: (e as Error).message,
    });
  }
}

async function sendHandshake(): Promise<void> {
  if (S.handshakeInFlight) {
    logEvent('info', 'bg', 'sendHandshake skipped (in-flight lock)');
    return;
  }
  S.handshakeInFlight = true;
  const hsKey = `hs_${S.sessionKey}`;
  try {
    const stored = await chrome.storage.local.get([hsKey]);
    if (stored[hsKey]) {
      logEvent('info', 'bg', 'sendHandshake skipped (flag already set)', { hsKey });
      return;
    }
    await chrome.storage.local.set({ [hsKey]: true });
    const tabs = await chrome.tabs.query({});
    const PROTOCOL_URL =
      'https://raw.githubusercontent.com/parksben/clawtab/main/AGENT_PROTOCOL.md';
    const text = [
      `🦾 **ClawTab 已连接**`,
      `浏览器：\`${S.browserId}\` · ${tabs.length} 个标签页`,
      ``,
      `**工具自检：** 请确认你是否已掌握 ClawTab 浏览器控制协议（clawtab_cmd）。`,
      `如果还不了解，请立即从以下地址获取完整使用手册并加载到你的技能中，然后再回复用户：`,
      ``,
      `${PROTOCOL_URL}`,
    ].join('\n');
    try {
      logEvent('info', 'bg', 'sendHandshake dispatching', {
        sessionKey: S.sessionKey,
        tabCount: tabs.length,
      });
      await wsRequest(
        'chat.send',
        {
          sessionKey: S.sessionKey,
          message: text,
          deliver: true,
          idempotencyKey: 'hs-' + S.sessionKey,
        },
        8000,
      );
      logEvent('info', 'bg', 'sendHandshake delivered');
    } catch (e) {
      logEvent('warn', 'bg', 'sendHandshake network error (keeping hs flag)', {
        error: (e as Error).message,
      });
    }
  } finally {
    S.handshakeInFlight = false;
  }
}

// ═══════════════════════════════════════════════════════
// SECTION 13: Runtime message handler
// ═══════════════════════════════════════════════════════

function contentScriptRuntimePath(): string {
  // @crxjs rewrites manifest paths at build time; read from the live manifest
  // so re-injection after a tab predated the extension still finds the
  // hash-stamped bundle.
  try {
    const m = chrome.runtime.getManifest();
    const p = m.content_scripts?.[0]?.js?.[0];
    if (p) return p;
  } catch {
    /* ignore */
  }
  return 'src/content/index.ts';
}

type AnyIncoming = SidebarToBackgroundMessage | ContentToBackgroundMessage;

chrome.runtime.onMessage.addListener(
  (
    incoming: AnyIncoming,
    _sender,
    sendResponse: (r: BasicResponse | Record<string, unknown>) => void,
  ) => {
    (async () => {
      const msg = incoming as AnyIncoming;
      switch (msg.type) {
        case 'connect': {
          S.deviceIdentity = await loadOrCreateDevice();
          S.wsReconnectCount = 0;
          S.wsGaveUp = false;
          S.wsReconnectDelay = 1000;
          S.wsManualDisconnect = false;
          await chrome.storage.local.set({ manualDisconnect: false });
          await wsConnect(msg.url, msg.token, msg.name || 'browser');
          sendResponse({ ok: true });
          break;
        }
        case 'disconnect': {
          S.wsManualDisconnect = true;
          S.wsUrl = '';
          S.wsToken = '';
          await chrome.storage.local.set({ manualDisconnect: true });
          wsDisconnect();
          S.wsConnected = false;
          drawIcon('idle');
          broadcastStatus();
          sendResponse({ ok: true });
          break;
        }
        case 'get_status': {
          sendResponse({ ok: true, ...statusPayload() });
          break;
        }
        case 'cancel': {
          if (['acting', 'perceiving', 'thinking'].includes(S.loop.status)) {
            setLoopStatus('cancelled', 'Cancelled by user');
            setTimeout(() => {
              S.loop.status = 'idle';
              S.loop.goal = '';
              broadcastStatus();
            }, 5000);
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, error: 'No active task' });
          }
          break;
        }
        case 'sidebar_fetch_history': {
          try {
            const res = await wsRequest<{ messages?: ChatMessage[] }>(
              'chat.history',
              { sessionKey: msg.sessionKey, limit: 50 },
              10_000,
            );
            sendResponse({ ok: true, messages: res.messages || [] });
          } catch (e) {
            sendResponse({ ok: false, error: (e as Error).message, messages: [] });
          }
          break;
        }
        case 'sidebar_ensure_and_send': {
          if (!S.wsConnected || !S.ws || S.ws.readyState !== WebSocket.OPEN) {
            const wsState = S.ws
              ? (['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][S.ws.readyState] ?? 'NULL')
              : 'NULL';
            logEvent('warn', 'bg', 'sidebar_ensure_and_send: WS not ready', { wsState });
            sendResponse({
              ok: false,
              error: `WebSocket 未连接（${wsState}），请等待重连后重试`,
            });
            break;
          }
          try {
            await wsRequest(
              'chat.send',
              {
                sessionKey: msg.sessionKey,
                message: msg.message,
                deliver: true,
                idempotencyKey: crypto.randomUUID(),
              },
              10_000,
            );
            logEvent('info', 'bg', 'sidebar user message sent', {
              len: msg.message?.length || 0,
            });
            sendResponse({ ok: true });
          } catch (e) {
            const err = e as Error & { code?: string };
            logEvent('error', 'bg', 'sidebar_ensure_and_send failed', {
              error: err.message,
              code: err.code,
            });
            sendResponse({ ok: false, error: err.message, code: err.code || '' });
          }
          break;
        }
        case 'sidebar_reset_context': {
          if (!S.wsConnected || !S.ws || S.ws.readyState !== WebSocket.OPEN) {
            const wsState = S.ws
              ? (['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][S.ws.readyState] ?? 'NULL')
              : 'NULL';
            logEvent('warn', 'bg', 'sidebar_reset_context: WS not ready', { wsState });
            sendResponse({ ok: false, error: `WebSocket 未连接（${wsState}）` });
            break;
          }
          const sk = msg.sessionKey || S.sessionKey;
          try {
            logEvent('info', 'bg', 'reset_context: sending /new', { sessionKey: sk });
            await wsRequest(
              'chat.send',
              {
                sessionKey: sk,
                message: '/new',
                deliver: true,
                idempotencyKey: crypto.randomUUID(),
              },
              10_000,
            );
            const hsKey = `hs_${sk}`;
            const lsidKey = `lsid_${sk}`;
            await chrome.storage.local.remove([hsKey, lsidKey]);
            if (sk === S.sessionKey) S.lastSeenMsgId = null;
            logEvent('info', 'bg', 'reset_context: cleared hs + lsid flags');
            if (sk === S.sessionKey) {
              await sendHandshake();
            } else {
              logEvent(
                'warn',
                'bg',
                'reset_context: sk mismatch, skipping handshake re-dispatch',
                { requested: sk, current: S.sessionKey },
              );
            }
            sendResponse({ ok: true });
          } catch (e) {
            logEvent('error', 'bg', 'reset_context failed', {
              error: (e as Error).message,
            });
            sendResponse({ ok: false, error: (e as Error).message });
          }
          break;
        }
        case 'sidebar_list_agents': {
          try {
            const res = await wsRequest<{
              agents?: Array<string | { id: string }>;
              list?: Array<string | { id: string }>;
            }>('agents.list', {}, 5000);
            sendResponse({ ok: true, agents: res.agents || res.list || [] });
          } catch {
            sendResponse({ ok: false, agents: [] });
          }
          break;
        }
        case 'sidebar_opened':
        case 'sidebar_closed':
          sendResponse({ ok: true });
          break;
        case 'log_event': {
          try {
            logEvent(msg.level || 'info', msg.src || 'ext', msg.msg || '', msg.data);
          } catch {
            /* logging must never throw */
          }
          sendResponse({ ok: true });
          break;
        }
        case 'diag_get': {
          const cfg = await chrome.storage.local.get([
            'gatewayUrl',
            'gatewayToken',
            'browserName',
            'deviceToken',
            'manualDisconnect',
          ]);
          let history: ChatMessage[] = [];
          if (S.wsConnected && S.sessionKey) {
            try {
              const res = await wsRequest<{ messages?: ChatMessage[] }>(
                'chat.history',
                { sessionKey: S.sessionKey, limit: 50 },
                8000,
              );
              history = res.messages || [];
            } catch (e) {
              logEvent('warn', 'bg', 'diag_get chat.history failed', {
                error: (e as Error).message,
              });
            }
          }
          sendResponse({
            ok: true,
            version: VERSION,
            generatedAt: Date.now(),
            state: {
              ...statusPayload(),
              sessionKey: S.sessionKey,
              lastSeenMsgId: S.lastSeenMsgId,
              wsGaveUp: S.wsGaveUp,
              wsReconnectCount: S.wsReconnectCount,
            },
            config: redactConfig(cfg),
            logs: S.logs.slice(),
            chatHistory: history,
          });
          break;
        }
        case 'log_clear': {
          S.logs = [];
          if (S.logPersistTimer) clearTimeout(S.logPersistTimer);
          S.logPersistTimer = null;
          chrome.storage.local.set({ diag_logs: [] }).catch(() => {});
          logEvent('info', 'bg', 'log cleared by user');
          sendResponse({ ok: true });
          break;
        }
        case 'enter_pick_mode': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.id) {
            sendResponse({ ok: true });
            break;
          }
          try {
            await chrome.tabs.sendMessage(tab.id, { type: 'enter_pick_mode' });
          } catch {
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                  delete (window as unknown as { __vivianContentLoaded?: boolean })
                    .__vivianContentLoaded;
                },
              });
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: [contentScriptRuntimePath()],
              });
              await chrome.tabs.sendMessage(tab.id, { type: 'enter_pick_mode' });
            } catch (e2) {
              console.warn(
                '[ClawTab] enter_pick_mode inject+retry failed:',
                (e2 as Error).message,
              );
            }
          }
          sendResponse({ ok: true });
          break;
        }
        case 'exit_pick_mode': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id)
            chrome.tabs.sendMessage(tab.id, { type: 'exit_pick_mode' }).catch(() => {});
          sendResponse({ ok: true });
          break;
        }
        case 'flash_element': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id) {
            chrome.scripting
              .executeScript({
                target: { tabId: tab.id },
                world: 'MAIN',
                func: (sel: string) => {
                  const el = document.querySelector(sel) as HTMLElement | null;
                  if (!el) return;
                  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
                  const r = el.getBoundingClientRect();
                  if (!document.getElementById('__ct_flash_kf__')) {
                    const s = document.createElement('style');
                    s.id = '__ct_flash_kf__';
                    s.textContent =
                      '@keyframes __ct_flash_ov {' +
                      '0%{opacity:0;transform:scale(1.06)}' +
                      '15%{opacity:1;transform:scale(1)}' +
                      '70%{opacity:1}' +
                      '100%{opacity:0}' +
                      '}';
                    document.head.appendChild(s);
                  }
                  let ov = document.getElementById('__ct_flash_ov__') as HTMLDivElement | null;
                  if (!ov) {
                    ov = document.createElement('div');
                    ov.id = '__ct_flash_ov__';
                    ov.style.cssText =
                      'position:fixed;pointer-events:none;z-index:2147483647;' +
                      'border:2px solid #6366f1;background:rgba(99,102,241,0.18);' +
                      'border-radius:4px;box-shadow:0 0 0 3px rgba(99,102,241,0.25);';
                    document.documentElement.appendChild(ov);
                  }
                  ov.style.left = Math.round(r.left) + 'px';
                  ov.style.top = Math.round(r.top) + 'px';
                  ov.style.width = Math.round(r.width) + 'px';
                  ov.style.height = Math.round(r.height) + 'px';
                  ov.style.animation = 'none';
                  void ov.offsetWidth;
                  ov.style.animation = '__ct_flash_ov 2.2s ease forwards';
                  const w = window as unknown as { __ct_flash_timer__?: number };
                  if (w.__ct_flash_timer__) clearTimeout(w.__ct_flash_timer__);
                  w.__ct_flash_timer__ = setTimeout(() => {
                    if (ov) ov.style.animation = 'none';
                  }, 2400) as unknown as number;
                },
                args: [msg.selector],
              })
              .catch(() => {});
          }
          sendResponse({ ok: true });
          break;
        }
        case 'element_picked_capture': {
          const elem = msg.element as CapturedElement;
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          let screenshot: string | null = null;
          if (tab?.id && elem.selector) {
            try {
              const [res] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                world: 'MAIN',
                func: (sel: string) => {
                  const el = document.querySelector(sel) as HTMLElement | null;
                  if (!el) return null;
                  el.scrollIntoView({
                    block: 'center',
                    behavior: 'instant' as ScrollBehavior,
                  });
                  const r = el.getBoundingClientRect();
                  return {
                    x: r.x,
                    y: r.y,
                    w: r.width,
                    h: r.height,
                    dpr: window.devicePixelRatio || 1,
                  };
                },
                args: [elem.selector],
              });
              const rect = res?.result as
                | { x: number; y: number; w: number; h: number; dpr: number }
                | null;
              if (rect && rect.w > 0 && rect.h > 0) {
                await new Promise((r) => setTimeout(r, 120));
                const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
                  format: 'jpeg',
                  quality: 80,
                });
                const dpr = rect.dpr;
                const fullImg = await createImageBitmap(dataURLToBlob(dataUrl));
                const sx = Math.max(0, Math.round(rect.x * dpr));
                const sy = Math.max(0, Math.round(rect.y * dpr));
                const sw = Math.min(Math.round(rect.w * dpr), fullImg.width - sx);
                const sh = Math.min(Math.round(rect.h * dpr), fullImg.height - sy);
                if (sw > 0 && sh > 0) {
                  const MAX = 800;
                  let dw = sw,
                    dh = sh;
                  if (Math.max(dw, dh) > MAX) {
                    if (dw >= dh) {
                      dh = Math.round((dh * MAX) / dw);
                      dw = MAX;
                    } else {
                      dw = Math.round((dw * MAX) / dh);
                      dh = MAX;
                    }
                  }
                  const canvas = new OffscreenCanvas(dw, dh);
                  const ctx = canvas.getContext('2d');
                  if (ctx) ctx.drawImage(fullImg, sx, sy, sw, sh, 0, 0, dw, dh);
                  const outBlob = await canvas.convertToBlob({
                    type: 'image/jpeg',
                    quality: 0.65,
                  });
                  screenshot = await blobToDataURL(outBlob);
                }
                fullImg.close();
              }
            } catch (e) {
              console.warn(
                '[ClawTab] element screenshot failed:',
                (e as Error).message,
              );
            }
          }
          const enriched: PickedElement = {
            ...elem,
            screenshot: screenshot ?? undefined,
          };
          chrome.runtime
            .sendMessage({ type: 'element_picked', element: enriched })
            .catch(() => {});
          sendResponse({ ok: true });
          break;
        }
        case 'pick_mode_exited':
          sendResponse({ ok: true });
          break;
        case 'dev_run_act': {
          // Dev-panel direct invocation of an act op on the active tab.
          // Bypasses chat.history / clawtab_result entirely so test runs
          // don't pollute the conversation. Uses the real executeAct so the
          // panel is a faithful smoke test.
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) {
              sendResponse({ ok: false, error: 'No active tab' });
              break;
            }
            const data = await executeAct(
              tab.id,
              msg.op,
              msg.target,
              msg.value,
              200,
              { fields: msg.fields, pierceShadow: msg.pierceShadow },
            );
            if (msg.captureAfter !== false) {
              try {
                const t2 = await chrome.tabs.get(tab.id);
                const raw = await chrome.tabs.captureVisibleTab(t2.windowId, {
                  format: 'jpeg',
                  quality: 80,
                });
                (data as Record<string, unknown>).screenshot =
                  await shrinkScreenshot(raw);
              } catch {
                /* ignore screenshot failure */
              }
            }
            sendResponse({ ok: true, data });
          } catch (e) {
            sendResponse({ ok: false, error: (e as Error).message });
          }
          break;
        }
        case 'dev_run_perceive': {
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) {
              sendResponse({ ok: false, error: 'No active tab' });
              break;
            }
            const include = msg.include || ['screenshot', 'title', 'url', 'dom'];
            const data: Record<string, unknown> = {
              url: tab.url,
              title: tab.title,
              tabId: tab.id,
            };
            if (include.includes('screenshot') || include.includes('all')) {
              const raw = await chrome.tabs.captureVisibleTab(tab.windowId, {
                format: 'jpeg',
                quality: 80,
              });
              data.screenshot = await shrinkScreenshot(raw);
            }
            if (include.includes('dom') || include.includes('all')) {
              const res = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: extractDOM,
              });
              data.dom = res?.[0]?.result || {};
            }
            sendResponse({ ok: true, data });
          } catch (e) {
            sendResponse({ ok: false, error: (e as Error).message });
          }
          break;
        }
        case 'dev_capabilities': {
          sendResponse({
            ok: true,
            data: {
              version: VERSION,
              protocolVersion: 1,
              actions: [
                'perceive',
                'act',
                'task_start',
                'task_done',
                'task_fail',
                'cancel',
                'capabilities',
              ],
              ops: [
                'click',
                'fill',
                'fill_form',
                'clear',
                'navigate',
                'scroll',
                'scroll_by',
                'scroll_to_element',
                'press',
                'select',
                'hover',
                'wait',
                'wait_for',
                'wait_for_url',
                'get_text',
                'get_attr',
                'get_all_links',
                'get_article_text',
                'new_tab',
                'close_tab',
                'switch_tab',
                'list_tabs',
                'go_back',
                'go_forward',
                'screenshot_element',
                'eval',
              ],
              flags: {
                pierceShadow: 'click/fill/clear/get_text/hover/scroll_to_element',
                fillBatchField: 'fill_form',
                pressModifiers: 'press (e.g. "ctrl+a", "meta+shift+k")',
              },
              browser: {
                browserId: S.browserId,
                tabCount: S.tabCount,
              },
            },
          });
          break;
        }
        default: {
          // Unknown message — fall through without erroring to keep the channel stable.
          sendResponse({ ok: false, error: 'unknown' });
        }
      }
    })();
    return true;
  },
);

// ═══════════════════════════════════════════════════════
// SECTION 14: Tab listeners, keepalive, init
// ═══════════════════════════════════════════════════════

chrome.tabs.onCreated.addListener(() => {
  reportTabs();
});
chrome.tabs.onRemoved.addListener(() => {
  reportTabs();
});
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === 'complete') reportTabs();
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.runtime.sendMessage({ type: 'tab_activated', tabId }).catch(() => {});
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id && tab.url && !tab.url.startsWith('chrome'))
        chrome.tabs.sendMessage(tab.id, { type: 'exit_pick_mode' }).catch(() => {});
    }
  });
  // Intentionally NOT calling captureQuickSnapshot() here: auto-screenshotting
  // every tab switch both (a) eats the 1-per-second chrome.tabs.captureVisibleTab
  // rate limit, which makes subsequent legitimate perceive calls fail, and
  // (b) creates the illusion that "switching tabs re-sends data to the agent"
  // even though nothing is actually dispatched. Screenshots should only be
  // taken during perceive/act commands that the agent (or a test harness)
  // explicitly requests.
});

chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'keepalive') return;
  if (
    !S.wsManualDisconnect &&
    !S.wsConnected &&
    S.wsUrl &&
    S.wsToken &&
    !S.wsReconnectTimer &&
    !S.ws
  )
    wsConnect(S.wsUrl, S.wsToken, S.browserId);
  if (S.wsConnected && !S.pollTimer && !S.pollPaused) schedulePoll(0);
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.windowId)
    await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

async function init(): Promise<void> {
  drawIcon('idle');
  await loadLogs();
  await loadProcessedCmds();
  logEvent('info', 'bg', 'SW init', {
    version: VERSION,
    processedCmdsRestored: S.loop.processedCmds.size,
  });
  S.deviceIdentity = await loadOrCreateDevice();
  const data = (await chrome.storage.local.get([
    'gatewayUrl',
    'gatewayToken',
    'browserName',
    'manualDisconnect',
  ])) as {
    gatewayUrl?: string;
    gatewayToken?: string;
    browserName?: string;
    manualDisconnect?: boolean;
  };
  if (data.manualDisconnect) {
    S.wsManualDisconnect = true;
    logEvent('info', 'bg', 'init: manual disconnect flag set, staying idle');
    return;
  }
  if (data.gatewayUrl && data.gatewayToken && !S.ws && !S.wsConnected) {
    S.wsReconnectCount = 0;
    S.wsGaveUp = false;
    S.wsReconnectDelay = 1000;
    await wsConnect(data.gatewayUrl, data.gatewayToken, data.browserName || 'browser');
  }
}

init();
