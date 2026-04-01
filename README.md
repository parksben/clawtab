# ClawTab

**ClawTab** is a Chrome extension that connects your browser to an [OpenClaw](https://github.com/openclaw/openclaw) Gateway, enabling AI agents to observe and control your browser tabs.

## Features

- 🔌 **Connect to any OpenClaw Gateway** — local or remote, via WebSocket
- 👁️ **Tab awareness** — AI agents can list all open tabs, read page content, and capture screenshots
- 🤖 **Agent selector** — choose which agents are allowed to control your browser
- ⚡ **Execute JS** — agents can run scripts, click elements, fill forms, and navigate pages
- 🏷️ **Browser identity** — set a custom name so the Gateway knows which browser is connected
- 💾 **Auto-save** — URL, token, and browser name are remembered across sessions
- 📌 **Fixed extension ID** — the `key` field in `manifest.json` pins the extension ID, so you never need to update Gateway config after reinstalling

## Installation

1. Download the latest ZIP: **[clawtab-main.zip](https://github.com/parksben/clawtab/archive/refs/heads/main.zip)**
2. Unzip the file
3. Open Chrome and go to `chrome://extensions/`
4. Enable **Developer mode** (top-right toggle)
5. Click **Load unpacked** and select the unzipped folder

The extension will always load with the fixed ID: `olfpncdbjlggonplhnlnbhkfianddhmp`

## Setup

1. Click the ClawTab icon in your Chrome toolbar
2. Fill in:
   - **Gateway URL** — e.g. `ws://localhost:18789` (local) or `wss://your-domain.com` (remote)
   - **Access Token** — the token configured in `gateway.auth.token`
   - **Browser Name** — a label to identify this browser in the Gateway (e.g. `my_work_browser`)
3. Click **Save & Connect**
4. Once connected, select which **Agents** are allowed to control this browser

## Gateway Configuration

To allow ClawTab to connect, add its fixed origin to `gateway.controlUi.allowedOrigins` in your OpenClaw config:

```json
{
  "gateway": {
    "auth": { "mode": "token", "token": "your-token-here" },
    "controlUi": {
      "allowedOrigins": [
        "http://localhost:18789",
        "chrome-extension://olfpncdbjlggonplhnlnbhkfianddhmp"
      ]
    }
  }
}
```

> **Fixed ID:** Thanks to the `key` field in `manifest.json`, ClawTab always uses the same extension ID (`olfpncdbjlggonplhnlnbhkfianddhmp`) regardless of where or how many times you reinstall it. You only need to add it to `allowedOrigins` once.

## Supported Commands

Once connected, OpenClaw agents can send the following commands to ClawTab:

| Command | Description |
|---|---|
| `get_tabs` | List all open tabs |
| `get_page_content` | Get text and HTML of a tab |
| `execute_js` | Run JavaScript in a tab |
| `navigate` | Navigate a tab to a URL |
| `screenshot` | Capture a screenshot of a tab |

## Privacy & Security

- ClawTab only connects to the Gateway URL you explicitly configure
- Agent access is restricted to the agents you select in the popup
- No data is sent to any third-party services

## License

MIT
