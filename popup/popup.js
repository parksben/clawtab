/**
 * popup.js - Popup UI 控制器
 */

const $ = (id) => document.getElementById(id);

const statusDot = $('statusDot');
const statusText = $('statusText');
const statusBadge = $('statusBadge');
const gatewayUrlInput = $('gatewayUrl');
const gatewayTokenInput = $('gatewayToken');
const connectBtn = $('connectBtn');
const disconnectBtn = $('disconnectBtn');
const toggleTokenBtn = $('toggleToken');
const statGateway = $('statGateway');
const statTabs = $('statTabs');
const statLastCmd = $('statLastCmd');

const STATUS_MAP = {
  connected: { dot: 'connected', text: '已连接', color: '#22c55e' },
  connecting: { dot: 'connecting', text: '连接中…', color: '#f59e0b' },
  disconnected: { dot: 'disconnected', text: '未连接', color: '#ef4444' }
};

function updateStatusUI(status, data = {}) {
  const s = STATUS_MAP[status] || STATUS_MAP.disconnected;
  statusDot.className = `status-dot ${s.dot}`;
  statusText.textContent = s.text;

  if (data.wsUrl) {
    let displayUrl = data.wsUrl;
    try {
      const u = new URL(data.wsUrl);
      displayUrl = u.host + u.pathname;
    } catch (_) {}
    statGateway.textContent = displayUrl;
    statGateway.title = data.wsUrl;
  } else {
    statGateway.textContent = '—';
  }

  if (data.tabCount !== undefined) {
    statTabs.textContent = data.tabCount;
  }

  if (data.lastCommand) {
    statLastCmd.textContent = data.lastCommand;
  }
}

// 加载已保存的配置
async function loadConfig() {
  const { gatewayUrl, gatewayToken } = await chrome.storage.local.get(['gatewayUrl', 'gatewayToken']);
  if (gatewayUrl) gatewayUrlInput.value = gatewayUrl;
  if (gatewayToken) gatewayTokenInput.value = gatewayToken;
}

// 获取 background 状态
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

// 连接
connectBtn.addEventListener('click', async () => {
  const url = gatewayUrlInput.value.trim();
  const token = gatewayTokenInput.value.trim();

  if (!url) {
    gatewayUrlInput.focus();
    gatewayUrlInput.style.borderColor = '#ef4444';
    setTimeout(() => { gatewayUrlInput.style.borderColor = ''; }, 1500);
    return;
  }
  if (!token) {
    gatewayTokenInput.focus();
    gatewayTokenInput.style.borderColor = '#ef4444';
    setTimeout(() => { gatewayTokenInput.style.borderColor = ''; }, 1500);
    return;
  }

  // 保存配置
  await chrome.storage.local.set({ gatewayUrl: url, gatewayToken: token });

  updateStatusUI('connecting', { wsUrl: url });
  connectBtn.disabled = true;
  connectBtn.textContent = '连接中…';

  try {
    await chrome.runtime.sendMessage({ type: 'connect', url, token });
  } catch (e) {
    console.error('Connect error:', e);
  }

  // 短暂延迟后刷新状态
  setTimeout(async () => {
    connectBtn.disabled = false;
    connectBtn.textContent = '保存并连接';
    await fetchStatus();
  }, 1200);
});

// 断开
disconnectBtn.addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'disconnect' });
  } catch (e) {}
  updateStatusUI('disconnected', { wsUrl: null, tabCount: 0, lastCommand: '—' });
});

// 显示/隐藏 Token
toggleTokenBtn.addEventListener('click', () => {
  const isPassword = gatewayTokenInput.type === 'password';
  gatewayTokenInput.type = isPassword ? 'text' : 'password';
});

// 监听来自 background 的状态推送
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status_update') {
    updateStatusUI(msg.status, {
      wsUrl: msg.wsUrl,
      tabCount: msg.tabCount,
      lastCommand: msg.lastCommand
    });
  }
});

// 初始化
(async () => {
  await loadConfig();
  await fetchStatus();
})();
