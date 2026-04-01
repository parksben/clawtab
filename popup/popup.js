/**
 * popup.js - Popup UI 控制器
 */

const $ = (id) => document.getElementById(id);

const statusDot = $('statusDot');
const statusText = $('statusText');
const gatewayUrlInput = $('gatewayUrl');
const gatewayTokenInput = $('gatewayToken');
const connectBtn = $('connectBtn');
const disconnectBtn = $('disconnectBtn');
const toggleTokenBtn = $('toggleToken');
const statGateway = $('statGateway');
const statTabs = $('statTabs');
const statLastCmd = $('statLastCmd');
const agentSection = $('agentSection');
const agentList = $('agentList');

const STATUS_MAP = {
  connected: { dot: 'connected', text: '已连接' },
  connecting: { dot: 'connecting', text: '连接中…' },
  pairing:    { dot: 'connecting', text: '等待配对…' },
  disconnected: { dot: 'disconnected', text: '未连接' }
};

// ── 状态 UI ────────────────────────────────────────────────────────────────

function updateStatusUI(status, data = {}) {
  const s = STATUS_MAP[status] || STATUS_MAP.disconnected;
  statusDot.className = `status-dot ${s.dot}`;
  statusText.textContent = s.text;

  if (data.wsUrl) {
    let displayUrl = data.wsUrl;
    try { const u = new URL(data.wsUrl); displayUrl = u.host; } catch (_) {}
    statGateway.textContent = displayUrl;
    statGateway.title = data.wsUrl;
  } else if (status === 'disconnected') {
    statGateway.textContent = '—';
  }

  if (data.tabCount !== undefined) statTabs.textContent = data.tabCount;
  if (data.lastCommand) statLastCmd.textContent = data.lastCommand;

  // 连接成功时展示 agent 选择区
  if (status === 'connected') {
    agentSection.style.display = '';
    loadAgents();
  } else {
    agentSection.style.display = 'none';
  }
}

// ── Agent 列表 ─────────────────────────────────────────────────────────────

async function loadAgents() {
  agentList.innerHTML = '<div class="agent-loading">加载中…</div>';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'agents_list' });
    const agents = resp?.agents || [];
    const { selectedAgents } = await chrome.storage.local.get(['selectedAgents']);
    const selected = new Set(selectedAgents || agents); // 默认全选

    if (agents.length === 0) {
      agentList.innerHTML = '<div class="agent-loading">未找到 Agent</div>';
      return;
    }

    agentList.innerHTML = '';
    agents.forEach(agentId => {
      const row = document.createElement('label');
      row.className = 'agent-row';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'agent-cb';
      cb.value = agentId;
      cb.checked = selected.has(agentId);
      cb.addEventListener('change', saveSelectedAgents);

      const icon = document.createElement('span');
      icon.className = 'agent-icon';
      icon.textContent = agentIconFor(agentId);

      const label = document.createElement('span');
      label.className = 'agent-label';
      label.textContent = agentId;

      row.appendChild(cb);
      row.appendChild(icon);
      row.appendChild(label);
      agentList.appendChild(row);
    });
  } catch (e) {
    agentList.innerHTML = '<div class="agent-loading">加载失败</div>';
  }
}

function agentIconFor(id) {
  if (id === 'main') return '🤖';
  if (id.includes('wechat')) return '💬';
  if (id.includes('dajin') || id.includes('大紧')) return '⚡';
  return '🔹';
}

async function saveSelectedAgents() {
  const checkboxes = agentList.querySelectorAll('input[type=checkbox]');
  const selected = [...checkboxes].filter(cb => cb.checked).map(cb => cb.value);
  await chrome.storage.local.set({ selectedAgents: selected });
  // 通知 background 更新
  chrome.runtime.sendMessage({ type: 'update_selected_agents', agents: selected }).catch(() => {});
}

// ── 配置草稿自动保存（不需要点按钮）─────────────────────────────────────────

let draftTimer = null;
function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 600);
}

async function saveDraft() {
  const url = gatewayUrlInput.value.trim();
  const token = gatewayTokenInput.value.trim();
  await chrome.storage.local.set({ gatewayUrlDraft: url, gatewayTokenDraft: token });
}

gatewayUrlInput.addEventListener('input', scheduleDraftSave);
gatewayTokenInput.addEventListener('input', scheduleDraftSave);

// ── 加载已保存配置 ──────────────────────────────────────────────────────────

async function loadConfig() {
  const data = await chrome.storage.local.get([
    'gatewayUrl', 'gatewayToken',
    'gatewayUrlDraft', 'gatewayTokenDraft'
  ]);
  // 优先使用草稿（最近输入的），其次用已保存的成功连接配置
  gatewayUrlInput.value   = data.gatewayUrlDraft   || data.gatewayUrl   || '';
  gatewayTokenInput.value = data.gatewayTokenDraft || data.gatewayToken || '';
}

// ── 获取 background 状态 ───────────────────────────────────────────────────

async function fetchStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'get_status' });
    if (resp) {
      updateStatusUI(resp.status, {
        wsUrl: resp.wsUrl,
        tabCount: resp.tabCount,
        lastCommand: resp.lastCommand
      });
    }
  } catch (e) {
    updateStatusUI('disconnected');
  }
}

// ── 连接 ────────────────────────────────────────────────────────────────────

connectBtn.addEventListener('click', async () => {
  const url   = gatewayUrlInput.value.trim();
  const token = gatewayTokenInput.value.trim();

  if (!url) {
    gatewayUrlInput.focus();
    gatewayUrlInput.classList.add('input-error');
    setTimeout(() => gatewayUrlInput.classList.remove('input-error'), 1500);
    return;
  }
  if (!token) {
    gatewayTokenInput.focus();
    gatewayTokenInput.classList.add('input-error');
    setTimeout(() => gatewayTokenInput.classList.remove('input-error'), 1500);
    return;
  }

  // 保存为"已确认"配置
  await chrome.storage.local.set({ gatewayUrl: url, gatewayToken: token,
                                    gatewayUrlDraft: url, gatewayTokenDraft: token });

  updateStatusUI('connecting', { wsUrl: url });
  connectBtn.disabled = true;
  connectBtn.textContent = '连接中…';

  try {
    await chrome.runtime.sendMessage({ type: 'connect', url, token });
  } catch (e) {
    console.error('Connect error:', e);
  }

  setTimeout(async () => {
    connectBtn.disabled = false;
    connectBtn.textContent = '保存并连接';
    await fetchStatus();
  }, 1500);
});

// ── 断开 ────────────────────────────────────────────────────────────────────

disconnectBtn.addEventListener('click', async () => {
  try { await chrome.runtime.sendMessage({ type: 'disconnect' }); } catch (e) {}
  updateStatusUI('disconnected', { tabCount: 0, lastCommand: '—' });
});

// ── 显示/隐藏 Token ──────────────────────────────────────────────────────────

toggleTokenBtn.addEventListener('click', () => {
  const isPassword = gatewayTokenInput.type === 'password';
  gatewayTokenInput.type = isPassword ? 'text' : 'password';
});

// ── 监听来自 background 的状态推送 ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status_update') {
    updateStatusUI(msg.status, {
      wsUrl: msg.wsUrl,
      tabCount: msg.tabCount,
      lastCommand: msg.lastCommand
    });
  }
});

// ── 初始化 ───────────────────────────────────────────────────────────────────

(async () => {
  await loadConfig();
  await fetchStatus();
})();
