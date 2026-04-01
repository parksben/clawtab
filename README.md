# Vivian Browser Agent 🤖

将你的 Chrome 浏览器与 [OpenClaw](https://openclaw.ai) AI 助手 **Vivian** 无缝连接。

通过 WebSocket 实时桥接，让 AI 能感知并操控你的浏览器。

---

## ✨ 功能

| 功能 | 描述 |
|------|------|
| 📋 标签页列表 | 实时上报所有打开标签页的 URL、标题、Favicon |
| 📄 页面内容 | 提取当前页面的文本和简化 HTML 结构 |
| 📸 截图 | 对任意标签页截取可见区域截图 |
| ⚡ 执行 JS | 在指定标签页注入并执行任意 JavaScript |
| 🧭 导航 | 控制标签页跳转到指定 URL |
| 🔌 自动重连 | 断线后指数退避自动重连（最大 30s） |

---

## 📦 安装步骤

### 1. 下载扩展文件

```bash
git clone https://github.com/parksben/vivian-browser-extension.git
```

### 2. 在 Chrome 中加载扩展

1. 打开 Chrome，进入地址栏输入：`chrome://extensions/`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择刚才克隆的 `vivian-browser-extension` 目录
5. 扩展图标出现在工具栏，安装完成 ✅

---

## 🔧 配置与使用

### 获取 Gateway URL 和 Token

1. 打开你的 OpenClaw 管理后台
2. 进入 **设置 → Browser Agent** 或 **插件 → 浏览器扩展**
3. 复制 WebSocket 地址（形如 `ws://your-server:3000/browser-agent`）和访问 Token

### 连接扩展

1. 点击 Chrome 工具栏中的 🤖 图标打开 Popup
2. 在 **Gateway URL** 输入框粘贴 WebSocket 地址
3. 在 **Access Token** 输入框粘贴 Token
4. 点击 **保存并连接**
5. 状态指示变为绿色 **已连接** 即成功 🎉

---

## 📡 通信协议

### 扩展 → Gateway（上报）

```json
// 标签页列表
{ "type": "tabs_list", "tabs": [{ "id": 1, "url": "...", "title": "...", "active": true, "favIconUrl": "..." }] }

// 页面内容
{ "type": "page_content", "tabId": 1, "url": "...", "title": "...", "text": "...", "html": "..." }

// 操作结果
{ "type": "action_result", "actionId": "xxx", "ok": true, "result": "..." }
```

### Gateway → 扩展（指令）

```json
// 获取所有标签页
{ "type": "get_tabs" }

// 获取指定标签页内容（tabId 可选，默认当前激活页）
{ "type": "get_page_content", "tabId": 1 }

// 执行 JavaScript
{ "type": "execute_js", "actionId": "abc123", "tabId": 1, "code": "document.title" }

// 导航到 URL
{ "type": "navigate", "actionId": "abc123", "tabId": 1, "url": "https://example.com" }

// 截图
{ "type": "screenshot", "actionId": "abc123", "tabId": 1 }
```

---

## 🏗️ 项目结构

```
vivian-browser-extension/
├── manifest.json          # MV3 扩展清单
├── background.js          # Service Worker，管理 WebSocket 生命周期
├── popup/
│   ├── popup.html         # Popup 页面
│   ├── popup.js           # Popup UI 控制器
│   └── popup.css          # 深色主题样式
├── content/
│   └── content.js         # 内容脚本，注入页面执行操作
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   ├── icon128.png
│   └── generate_icons.js  # 图标生成脚本（需 npm install canvas）
└── README.md
```

---

## 🔒 权限说明

| 权限 | 用途 |
|------|------|
| `tabs` | 查询和操控标签页 |
| `activeTab` | 访问当前激活标签页 |
| `scripting` | 向页面注入脚本 |
| `storage` | 保存 Gateway URL 和 Token |
| `alarms` | 定期检查并保持 Service Worker 活跃 |
| `<all_urls>` | 在任意页面注入内容脚本（执行 AI 操作） |

---

## 🛠️ 开发说明

扩展采用纯 Manifest V3，无需构建工具：

```bash
# 克隆仓库
git clone https://github.com/parksben/vivian-browser-extension.git

# 直接在 Chrome 开发者模式加载即可
```

如需重新生成图标（需 Node canvas 模块）：

```bash
cd icons
npm install canvas
node generate_icons.js
```

---

## ⚠️ 注意事项

- 部分页面（`chrome://`、扩展管理页等）无法注入内容脚本，获取页面内容时会返回提示信息
- 截图功能会临时激活目标标签页，使用时请注意
- Token 保存在 `chrome.storage.local`，仅本机可访问，不会上传到任何服务器

---

## 📄 License

MIT

---

> 🤖 **Vivian** · Powered by [OpenClaw](https://openclaw.ai)
