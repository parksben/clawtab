# ClawTab

> 中文文档：[README_ZH.md](./README_ZH.md)

**ClawTab** is a Chrome extension that connects your browser to an [OpenClaw](https://github.com/openclaw/openclaw) Gateway, enabling AI agents to observe and control your browser tabs.

## Highlights

- **AI chat in the sidebar** — click the icon to open the sidebar and talk to agents directly; config, chat, and task controls all in one place
- **Full browser automation** — agents can read page content, click, fill forms, and navigate; results are reported back in real time
- **Live task visibility** — while a task runs, a status bar shows the goal, current step, and a live screenshot thumbnail (click to fullscreen)
- **Multi-agent support** — switch between agents in the sidebar; each agent keeps its own session and chat history
- **One-click diagnostics** — every connection / poll / handshake / perceive / act event is logged into a 500-entry ring buffer; export the bundle as a `.txt` file straight from the chat header

## Quick Start

### 1. Install the extension

1. Download: **[clawtab-main.zip](https://github.com/parksben/clawtab/archive/refs/heads/main.zip)**
2. Unzip the archive, then in that folder run:
   ```bash
   pnpm install
   pnpm build
   ```
   This produces a `dist/` directory.
3. Open `chrome://extensions/` and enable **Developer mode**
4. Click **Load unpacked** → select the **`dist/`** directory (not the repo root)

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

## Project Structure

```
src/
  background/index.ts    # Service Worker (WebSocket, polling, perceive/act dispatcher)
  content/index.ts       # Content script (element picker, page ops)
  sidebar/               # React + Tailwind sidebar
    App.tsx              # state owner, polling loop, runtime message subscription
    main.tsx             # React root
    index.html           # sidepanel entry
    styles.css           # Tailwind layers + .md-bubble component styles
    i18n.ts              # zh/en strings + t() helper
    components/          # ConfigPage / ChatPage / ChatHeader / TaskBar /
                         # MessageList / MessageBubble / InputArea /
                         # IconButton / Tooltip / Toast
    hooks/useLang.ts     # persisted language preference
    state/reducer.ts     # pure useReducer reducer + selectVisibleMessages
    lib/                 # markdown / messages / message-utils
  shared/types/          # cross-context types (messages / protocol / state / picker)
  manifest.ts            # @crxjs MV3 manifest source
icons/*.png              # toolbar icons
docs/REQUIREMENTS.md     # what ClawTab does + user-visible behavior
docs/TECH_DESIGN.md      # how it's built + key invariants
```

## Development

| Command | Purpose |
|---------|---------|
| `pnpm install` | Install deps (once) |
| `pnpm build` | One-shot production build into `dist/` |
| `pnpm build:watch` | Rebuild on file change — pair with **Reload extension** in `chrome://extensions/` |
| `pnpm typecheck` | `tsc --noEmit` over `src/` |
| `pnpm test` | Run Vitest test suite (currently 36 tests covering message dedup + reducer state machine) |
| `pnpm test:watch` | Vitest in watch mode |

There is no Vite dev server / HMR flow — sidepanel HMR is flaky inside `@crxjs`. Use `pnpm build:watch` plus a manual extension reload instead.

## Privacy & Security

ClawTab only connects to the Gateway URL you explicitly configure. No data is sent to any third-party services.

## License

MIT

