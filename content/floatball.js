/**
 * ClawTab floatball.js — content script
 * Floating ball + expandable chat panel injected into every page.
 */
(function () {
  'use strict';
  if (window.__ctFloatball) return;
  window.__ctFloatball = true;

  // ── State ──────────────────────────────────────────────────────────────────
  const STATE = {
    wsConnected:   false,
    channelName:   '',
    selectedAgent: 'main',
    lastMsgId:     null,
    messages:      [],
    polling:       null,
    sending:       false,
    panelOpen:     false,
  };

  const DEFAULT_AGENTS = ['main', 'dajin', 'coder', 'wechat-new', 'biz-coder'];

  // ── Build DOM ──────────────────────────────────────────────────────────────
  const root = document.createElement('div');
  root.id = 'ct-root';
  root.className = 'ct-hidden';

  root.innerHTML = `
    <div id="ct-panel">
      <div class="ct-header">
        <div class="ct-brand">
          <img class="ct-logo" src="${chrome.runtime.getURL('icons/icon48.png')}" alt="">
          <span class="ct-title">ClawTab</span>
        </div>
        <div class="ct-header-right">
          <select class="ct-agent-select" id="ct-agent-select"></select>
          <div class="ct-status-badge">
            <div class="ct-status-dot" id="ct-status-dot"></div>
            <span id="ct-status-text">未连接</span>
          </div>
          <button class="ct-close-btn" id="ct-close-btn" title="关闭">✕</button>
        </div>
      </div>
      <div class="ct-messages" id="ct-messages"></div>
      <div class="ct-input-area">
        <textarea class="ct-input" id="ct-input" rows="1"
          placeholder="发消息…（Enter 发送，Shift+Enter 换行）"></textarea>
        <button class="ct-send-btn" id="ct-send-btn" disabled>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>
    </div>
    <div id="ct-ball">
      <img src="${chrome.runtime.getURL('icons/icon48.png')}" alt="ClawTab">
      <div id="ct-ball-dot"></div>
    </div>
  `;

  document.documentElement.appendChild(root);

  // ── Helpers ────────────────────────────────────────────────────────────────
  function sessionKey() {
    return `agent:${STATE.selectedAgent}:clawtab-${STATE.channelName}`;
  }

  function bg(msg) {
    return chrome.runtime.sendMessage(msg);
  }

  function msgText(msg) {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content))
      return msg.content.filter(b => b.type === 'text').map(b => b.text || '').join('');
    if (msg.blocks)
      return msg.blocks.filter(b => b.type === 'text').map(b => b.text || '').join('');
    return '';
  }

  function extractJsonBlock(text) {
    const m = text.match(/```json\s*([\s\S]*?)```/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  }

  function summariseCmd(cmd) {
    const actionMap = {
      perceive:   '🔍 感知页面',
      act:        '🖱️ 操作页面',
      task_start: '▶️ 任务开始',
      task_done:  '✅ 任务完成',
      task_fail:  '❌ 任务失败',
      cancel:     '🚫 已取消',
    };
    const opMap = {
      navigate:   '🌐 导航',
      click:      '🖱️ 点击',
      fill:       '✏️ 填写',
      screenshot: '📸 截图',
      scroll:     '↕️ 滚动',
      eval:       '⚡ 执行脚本',
      get_text:   '📋 读取文本',
      new_tab:    '➕ 新标签页',
      close_tab:  '✖️ 关闭标签页',
    };
    const op   = cmd.payload?.op;
    const base = actionMap[cmd.action] || `⚙️ ${cmd.action}`;
    const detail = op ? (opMap[op] || op) : '';
    return detail ? `${base} · ${detail}` : base;
  }

  const esc = s => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function formatText(raw) {
    return esc(raw)
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function buildMsgNode(msg) {
    const text = msgText(msg);
    if (!text.trim()) return null;

    const json = extractJsonBlock(text);
    if (json?.type === 'clawtab_result') return null;
    if (json?.type === 'clawtab_cmd') {
      const row = document.createElement('div');
      row.className = 'ct-tool-row';
      row.textContent = summariseCmd(json);
      return row;
    }

    const cleaned = text.replace(/```json[\s\S]*?```/g, '').trim();
    if (!cleaned) return null;

    const role = msg.role === 'user' ? 'user' : 'assistant';
    const wrap = document.createElement('div');
    wrap.className = `ct-msg ${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'ct-bubble';
    bubble.innerHTML = formatText(cleaned);
    wrap.appendChild(bubble);
    return wrap;
  }

  function renderMessages() {
    const el = document.getElementById('ct-messages');
    if (!el) return;

    if (!STATE.wsConnected) {
      el.innerHTML = `<div class="ct-empty"><div class="ct-empty-icon">🦞</div><div>请先连接 OpenClaw</div></div>`;
      return;
    }

    const visible = STATE.messages.filter(m => {
      const json = extractJsonBlock(msgText(m));
      return !json || json.type !== 'clawtab_result';
    });

    if (visible.length === 0) {
      el.innerHTML = `<div class="ct-empty"><div class="ct-empty-icon">💬</div><div>向 <strong>${STATE.selectedAgent}</strong> 发消息，开始对话</div></div>`;
      return;
    }

    el.innerHTML = '';
    for (const msg of visible) {
      const node = buildMsgNode(msg);
      if (node) el.appendChild(node);
    }
    el.scrollTop = el.scrollHeight;
  }

  // ── Polling ────────────────────────────────────────────────────────────────
  function startPolling() {
    if (STATE.polling) return;
    STATE.polling = setInterval(fetchHistory, 3000);
  }

  function stopPolling() {
    if (STATE.polling) { clearInterval(STATE.polling); STATE.polling = null; }
  }

  async function fetchHistory() {
    if (!STATE.wsConnected || !STATE.channelName) return;
    try {
      const res = await bg({
        type:       'sidebar_fetch_history',
        sessionKey: sessionKey(),
        after:      STATE.lastMsgId,
      });
      if (!res?.ok || !res.messages?.length) return;

      const el = document.getElementById('ct-messages');
      const emptyEl = el?.querySelector('.ct-empty');
      if (emptyEl) el.innerHTML = '';

      for (const m of res.messages) {
        STATE.lastMsgId = m.id;
        STATE.messages.push(m);
        const node = buildMsgNode(m);
        if (node && el) el.appendChild(node);
      }
      if (el) el.scrollTop = el.scrollHeight;
    } catch (_) {}
  }

  // ── Send ───────────────────────────────────────────────────────────────────
  async function sendMessage() {
    const input = document.getElementById('ct-input');
    const text  = input?.value.trim();
    if (!text || !STATE.wsConnected || STATE.sending) return;

    STATE.sending = true;
    const btn = document.getElementById('ct-send-btn');
    if (btn) btn.disabled = true;
    input.value = '';
    input.style.height = '';

    const localMsg = { id: `local-${Date.now()}`, role: 'user', content: text };
    STATE.messages.push(localMsg);
    const el = document.getElementById('ct-messages');
    const emptyEl = el?.querySelector('.ct-empty');
    if (emptyEl) el.innerHTML = '';
    const node = buildMsgNode(localMsg);
    if (node && el) { el.appendChild(node); el.scrollTop = el.scrollHeight; }

    try {
      await bg({
        type:       'sidebar_ensure_and_send',
        sessionKey: sessionKey(),
        message:    text,
      });
    } catch (e) {
      console.warn('[ClawTab] send failed:', e.message);
    } finally {
      STATE.sending = false;
      if (btn) btn.disabled = !STATE.wsConnected;
    }
  }

  // ── Status ─────────────────────────────────────────────────────────────────
  function updateStatus() {
    const dot  = document.getElementById('ct-status-dot');
    const text = document.getElementById('ct-status-text');
    const btn  = document.getElementById('ct-send-btn');
    const ballDot = document.getElementById('ct-ball-dot');

    if (STATE.wsConnected) {
      dot?.classList.add('connected');
      ballDot?.classList.add('connected');
      if (text) text.textContent = '已连接';
      if (btn) btn.disabled = false;
    } else {
      dot?.classList.remove('connected');
      ballDot?.classList.remove('connected');
      if (text) text.textContent = '未连接';
      if (btn) btn.disabled = true;
    }
  }

  // ── Agent selector ─────────────────────────────────────────────────────────
  async function loadAgents() {
    const sel = document.getElementById('ct-agent-select');
    if (!sel) return;
    sel.innerHTML = '';

    let agents = DEFAULT_AGENTS;
    try {
      const res = await bg({ type: 'sidebar_list_agents' });
      if (res?.agents?.length > 0)
        agents = res.agents.map(a => (typeof a === 'string' ? a : a.id || String(a)));
    } catch (_) {}

    for (const a of agents) {
      const opt = document.createElement('option');
      opt.value = a; opt.textContent = a;
      if (a === STATE.selectedAgent) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function switchAgent(newAgent) {
    if (newAgent === STATE.selectedAgent) return;
    STATE.selectedAgent = newAgent;
    STATE.messages      = [];
    STATE.lastMsgId     = null;
    stopPolling();
    renderMessages();
    if (STATE.wsConnected) { fetchHistory(); startPolling(); }
  }

  // ── Panel open / close ─────────────────────────────────────────────────────
  function openPanel() {
    STATE.panelOpen = true;
    document.getElementById('ct-panel')?.classList.add('ct-open');
  }

  function closePanel() {
    STATE.panelOpen = false;
    document.getElementById('ct-panel')?.classList.remove('ct-open');
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    await loadAgents();

    try {
      const s = await bg({ type: 'get_status' });
      if (s) {
        STATE.wsConnected = s.wsConnected || false;
        STATE.channelName = s.browserId   || '';
      }
    } catch (_) {}

    if (STATE.wsConnected) root.classList.remove('ct-hidden');
    updateStatus();
    renderMessages();

    if (STATE.wsConnected && STATE.channelName) {
      await fetchHistory();
      startPolling();
    }
  }

  // ── Events ─────────────────────────────────────────────────────────────────
  document.getElementById('ct-ball').addEventListener('click', () => {
    if (STATE.panelOpen) closePanel(); else openPanel();
  });

  document.getElementById('ct-close-btn').addEventListener('click', closePanel);

  document.getElementById('ct-send-btn').addEventListener('click', sendMessage);

  document.getElementById('ct-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  document.getElementById('ct-input').addEventListener('input', e => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 100) + 'px';
  });

  document.getElementById('ct-agent-select').addEventListener('change', e => {
    switchAgent(e.target.value);
  });

  // Listen for status broadcasts from background
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type !== 'status_update') return;
    const wasConnected = STATE.wsConnected;
    STATE.wsConnected  = msg.wsConnected || false;
    STATE.channelName  = msg.browserId   || STATE.channelName;

    // Show/hide the ball based on connection
    if (STATE.wsConnected) root.classList.remove('ct-hidden');
    else root.classList.add('ct-hidden');

    updateStatus();

    if (!wasConnected && STATE.wsConnected) {
      STATE.messages  = [];
      STATE.lastMsgId = null;
      renderMessages();
      fetchHistory();
      startPolling();
    } else if (wasConnected && !STATE.wsConnected) {
      stopPolling();
      closePanel();
      renderMessages();
    }
  });

  // ── Boot ───────────────────────────────────────────────────────────────────
  init();
})();
