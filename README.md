# ClawTab

**ClawTab** is a Chrome extension that connects your browser to an [OpenClaw](https://github.com/openclaw/openclaw) Gateway, enabling AI agents to observe and control your browser tabs.

## Features

- 🔌 **Connect to any OpenClaw Gateway** — local or remote, via WebSocket
- 👁️ **Tab awareness** — list all open tabs, read page content, and capture screenshots
- 🤖 **Agent selector** — choose which agents are allowed to control your browser
- ⚡ **Execute JS** — run scripts, click elements, fill forms, and navigate pages
- 🏷️ **Browser identity** — set a custom name so the Gateway knows which browser is connected
- 💾 **Auto-save** — URL, token, and browser name are remembered across sessions
- 📌 **Fixed extension ID** — pinned via `manifest.json` key, survives reinstalls
- 🌐 **Bilingual UI** — switch between Chinese and English in the popup

## Installation

1. Download: **[clawtab-main.zip](https://github.com/parksben/clawtab/archive/refs/heads/main.zip)**
2. Unzip the file
3. Go to `chrome://extensions/` → enable **Developer mode**
4. Click **Load unpacked** → select the unzipped folder

Fixed extension ID: `olfpncdbjlggonplhnlnbhkfianddhmp`

## Setup

1. Click the ClawTab icon in your toolbar
2. Fill in **Gateway URL**, **Access Token**, and an optional **Browser Name**
3. Click **Connect**
4. Once connected, select which **Agents** can control this browser

## Gateway Configuration

Add ClawTab's origin to `gateway.controlUi.allowedOrigins`:

```json
{
  "gateway": {
    "auth": { "mode": "token", "token": "your-token" },
    "controlUi": {
      "allowedOrigins": [
        "https://your-domain.com",
        "chrome-extension://olfpncdbjlggonplhnlnbhkfianddhmp"
      ]
    }
  }
}
```

> ⚠️ **Restart required:** After modifying `allowedOrigins` or `gateway.auth`, you must **fully restart** the OpenClaw Gateway. A hot-reload (SIGUSR1) is **not** sufficient for these settings.
>
> ```bash
> systemctl restart openclaw-gateway
> ```

## Supported Commands

| Command | Description |
|---|---|
| `get_tabs` | List all open tabs |
| `get_page_content` | Get text and HTML of a tab |
| `execute_js` | Run JavaScript in a tab |
| `navigate` | Navigate a tab to a URL |
| `screenshot` | Capture a screenshot of a tab |

## License

MIT

---

# ClawTab [中文]

**ClawTab** 是一个 Chrome 扩展，将你的浏览器连接到 [OpenClaw](https://github.com/openclaw/openclaw) Gateway，让 AI Agent 能够感知和控制浏览器标签页。

## 功能特性

- 🔌 **连接任意 OpenClaw Gateway** — 本地或远程，通过 WebSocket
- 👁️ **标签页感知** — 列出所有标签页、读取页面内容、截图
- 🤖 **Agent 选择器** — 选择哪些 Agent 可以控制你的浏览器
- ⚡ **执行 JS** — 运行脚本、点击元素、填写表单、页面导航
- 🏷️ **浏览器标识** — 设置自定义名称，让 Gateway 识别是哪台浏览器
- 💾 **自动保存** — URL、Token、浏览器名称在会话间持久保存
- 📌 **固定 extension ID** — 通过 `manifest.json` key 锁定，重装不变
- 🌐 **中英文切换** — popup 右上角一键切换语言

## 安装

1. 下载：**[clawtab-main.zip](https://github.com/parksben/clawtab/archive/refs/heads/main.zip)**
2. 解压
3. 打开 `chrome://extensions/`，开启右上角**开发者模式**
4. 点击**加载已解压的扩展程序**，选择解压后的文件夹

固定 Extension ID：`olfpncdbjlggonplhnlnbhkfianddhmp`

## 使用

1. 点击工具栏中的 ClawTab 图标
2. 填写 **Gateway URL**、**Access Token**，以及可选的**浏览器名称**
3. 点击**保存并连接**
4. 连接成功后，勾选允许控制浏览器的 Agent

## Gateway 配置

将 ClawTab 的 origin 加入 `gateway.controlUi.allowedOrigins`：

```json
{
  "gateway": {
    "auth": { "mode": "token", "token": "你的token" },
    "controlUi": {
      "allowedOrigins": [
        "https://你的域名.com",
        "chrome-extension://olfpncdbjlggonplhnlnbhkfianddhmp"
      ]
    }
  }
}
```

> ⚠️ **需要重启：** 修改 `allowedOrigins` 或 `gateway.auth` 后，必须**完整重启** OpenClaw Gateway 才能生效，热重载（SIGUSR1）对这些配置**无效**。
>
> ```bash
> systemctl restart openclaw-gateway
> ```

## 支持的指令

| 指令 | 描述 |
|---|---|
| `get_tabs` | 列出所有标签页 |
| `get_page_content` | 获取标签页的文本和 HTML |
| `execute_js` | 在标签页中执行 JavaScript |
| `navigate` | 导航标签页到指定 URL |
| `screenshot` | 截取标签页截图 |

## License

MIT
