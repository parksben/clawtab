# ClawTab Agent Protocol

How OpenClaw agents interact with ClawTab to perform browser automation.

## Standard Pre-flight Sequence

Before any automation task, the agent should:

### Step 0 — Discover connected browsers

Send via Gateway chat session:
> "List connected browsers via ClawTab"

The agent calls `chat.send` and waits for a `browser_info` event, or sends:

```json
{ "type": "get_tabs" }
```

Response includes `browserName`, `authorizedAgents`, `totalTabs`.

### Step 1 — Check authorization

Send `browser_check` command:

```json
{
  "type": "browser_check",
  "checkId": "chk-001",
  "agentId": "main"
}
```

Response `browser_check_result`:

```json
{
  "type": "browser_check_result",
  "checkId": "chk-001",
  "browserName": "my_work_browser",
  "authorized": true,
  "authorizedAgents": ["main", "dajin"],
  "tabs": [
    { "id": 1, "url": "https://example.com", "title": "Example", "active": true, "screenshot": "data:image/jpeg;..." }
  ],
  "totalTabs": 3
}
```

If `authorized: false` → stop, inform user.

### Step 2 — Plan the task

Agent analyzes the tab snapshot (titles, URLs, screenshots) and plans steps.

### Step 3 — Send task plan

```json
{
  "type": "task_plan",
  "taskId": "task-abc123",
  "taskName": "采集商品价格",
  "agentId": "main",
  "steps": [
    { "type": "navigate",    "label": "打开商品页", "tabId": 1, "url": "https://shop.example.com/item/123" },
    { "type": "wait",        "label": "等待加载",   "ms": 1500 },
    { "type": "execute_js",  "label": "提取价格",   "tabId": 1, "code": "document.querySelector('.price')?.innerText" },
    { "type": "screenshot",  "label": "截图存档",   "tabId": 1 }
  ]
}
```

**Step types:**

| type | required fields | description |
|---|---|---|
| `navigate` | `tabId`, `url` | Navigate a tab |
| `execute_js` | `tabId`, `code` | Run JS, returns result |
| `screenshot` | `tabId` | Capture JPEG screenshot |
| `get_content` | `tabId` | Get page text + HTML |
| `wait` | `ms` | Pause (ms) |

Optional on each step: `label` (display name), `timeout` (ms), `abortOnError: false` (continue on failure)

### Step 4 — Monitor progress

ClawTab pushes after each step:

```json
{
  "type": "task_step_result",
  "taskId": "task-abc123",
  "stepIndex": 2,
  "step": { "type": "execute_js", "label": "提取价格", ... },
  "ok": true,
  "result": "¥ 299.00"
}
```

### Step 5 — Receive final result

```json
{
  "type": "task_result",
  "taskId": "task-abc123",
  "ok": true,
  "results": [
    { "step": 0, "ok": true, "result": "Navigated to ..." },
    { "step": 1, "ok": true, "result": "waited 1500ms" },
    { "step": 2, "ok": true, "result": "¥ 299.00" },
    { "step": 3, "ok": true, "result": "data:image/jpeg;base64,..." }
  ]
}
```

## Cancel a task

```json
{ "type": "task_cancel", "taskId": "task-abc123" }
```

User can also cancel from the ClawTab popup.

## Error handling

- If a step fails and `abortOnError` is not `false`, the task stops immediately
- `task_result` with `ok: false` includes the `error` message
- Each step result is available even if the task failed partway
