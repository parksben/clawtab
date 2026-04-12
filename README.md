# ClawTab

> 中文文档：[README_ZH.md](./README_ZH.md)

**ClawTab** is a Chrome extension that connects your browser to an [OpenClaw](https://github.com/openclaw/openclaw) Gateway, enabling AI agents to observe and control your browser tabs.

## Highlights

- **AI chat in the sidebar** — click the icon to open the sidebar and talk to agents directly; config, chat, and task controls all in one place
- **Full browser automation** — agents can read page content, click, fill forms, and navigate; results are reported back in real time
- **Live task visibility** — while a task runs, a status bar shows the goal, current step, and a live screenshot thumbnail (click to fullscreen)
- **Multi-agent support** — switch between agents in the sidebar; each agent keeps its own session and chat history

## Quick Start

### 1. Install the extension

1. Download: **[clawtab-main.zip](https://github.com/parksben/clawtab/archive/refs/heads/main.zip)**
2. Unzip, then go to `chrome://extensions/` and enable **Developer mode**
3. Click **Load unpacked** → select the unzipped folder

### 2. Configure the Gateway

Run this on the machine where OpenClaw Gateway is installed:

```bash
curl -fsSL https://raw.githubusercontent.com/parksben/clawtab/main/scripts/setup-gateway.sh | bash
```

The script auto-detects your config, adds ClawTab's origin to `allowedOrigins`, and restarts the service. A backup is saved automatically.

> **Manual setup:** Add the following origin to `gateway.controlUi.allowedOrigins`, then run `systemctl restart openclaw-gateway`.
> ClawTab has a fixed extension ID — every user adds the same origin:
>
> ```
> chrome-extension://olfpncdbjlggonplhnlnbhkfianddhmp
> ```

### 3. Connect

1. Click the **ClawTab** icon — the sidebar opens
2. Fill in **Gateway URL**, **Access Token**, and a **Channel Name**
3. Click **Connect** — the sidebar switches to chat mode automatically

The session `agent:main:clawtab-{channel}` appears in the OpenClaw Web UI.

## Privacy & Security

ClawTab only connects to the Gateway URL you explicitly configure. No data is sent to any third-party services.

## License

MIT
