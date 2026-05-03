# ClawTab — 需求文档

> ClawTab 是一个 Chrome 扩展（Manifest V3），将本地浏览器接入 OpenClaw Gateway，让远端 AI Agent 通过 chat 会话观察并控制当前浏览器的标签页。

## 目标用户与使用场景

- **谁在用：** 已经部署 OpenClaw Gateway 的开发者 / 实验型用户。
- **典型场景：**
  1. 在浏览器中安装本扩展并填写 Gateway URL / Token / 渠道名。
  2. 完成一次 Ed25519 握手与设备配对（首次需通过 CLI `openclaw devices approve`）。
  3. 在侧边栏与 Agent 对话，Agent 通过 `clawtab_cmd` 协议感知 / 操作浏览器。

## 用户可见行为

### 连接与配对
- 配置页填入 URL / Token / Channel Name 后点击连接，未配对设备应展示配对码 + CLI 命令。
- 配对成功后切换到 Chat 页面；断开 / 失败时回到配置页并给出明确状态。

### 对话与消息
- 用户在 Chat 页面与 Agent 实时对话，使用 markdown 渲染。
- 消息列表占据 header / 任务栏 / 输入框之间的剩余高度，**自身可以独立滚动**；新消息自动滚到底，不应把输入框挤出可视区。
- **消息排版**：消息卡片宽度受容器约束，长链接 / 代码块强制换行，**不允许出现横向滚动**。用户消息保持气泡，靠右对齐，最大宽度 = 容器宽度 − 120px；Agent 回复**不带气泡**，以全宽 Markdown 直接铺满容器。
- 输入框是单个文本域，**根据内容行数自动撑高**，**自身不出现滚动条**；左右两侧的功能按钮（拾取 / 清空 / 发送）始终与输入框底边对齐。
- 连接建立后，扩展会自动向会话发一条"握手提示"消息（提示 Agent 加载协议手册），握手消息**只发送一次**：
  - 同一 `sessionKey` 在本地标记为已发送之后，无论 Service Worker 重启、WebSocket 重连、还是 Gateway 报告"全新会话"，都不再重发。
  - 即使 `chat.send` 因为 WS 中途掉线而抛错（消息可能其实已被 Gateway 接收），客户端也不会撤销这个标记 —— 宁可少发，也不会重发出现重复气泡。
- **消息列表不应出现重复**：同一条消息（包括握手消息、Agent 回复、用户消息）只会在聊天列表中渲染一次，无论后台轮询了多少轮 `chat.history`。
- 消息中的链接（markdown 自动识别的 URL 或显式 `[text](url)`）点击后会在浏览器**新标签页**中打开，不会替换 sidebar 自身。
- 工具调用 / `clawtab_cmd` 以紧凑的图标行展示；`clawtab_result` 对用户隐藏。
- **清空上下文**：输入框左侧（拾取按钮右侧）有一枚"新对话"按钮：
  - 仅在已连接时可用，点击后弹 confirm 防止误触。
  - 点击后：聊天区域立刻清空 → 向 agent 发一条 `/new` 指令（不渲染这条 user message，只用来告诉 agent 重置上下文）→ 本地清掉 `hs_<sessionKey>` 握手标记 → 自动重新发一次协议握手消息，确保 agent 清空后仍然认识 `clawtab_cmd` 协议、工具不失效。
  - **重要**：Gateway 不会因为 `/new` 而删除 `chat.history` 里的旧消息，下一轮 polling 仍会把它们捞回来。客户端必须把"清空时刻可见的所有消息"持久化为隔离标记，并在每次 hydrate 时过滤掉这些消息——**这个隔离必须跨"关闭再打开 sidepanel"持续生效**，否则用户重新打开扩展会看到旧会话又冒出来。
  - 最终用户看到的效果：聊天从空开始 → 很快出现一条新的"🦾 ClawTab 已连接"握手气泡 → agent 就绪。即使关掉 sidepanel 再打开、甚至重启浏览器，已清空的旧消息也不会再出现。

- **不可见消息**：以下消息出现在 `chat.history` 里，但**不应**渲染到用户聊天列表：
  - `role:"toolResult"`：agent 自身的工具调用结果（`web_fetch`、`sessions_send`、`sessions_history` 等返回的 JSON dump）。
  - `provenance.kind === "inter_session"` 的 user 消息：agent 通过 `sessions_send` 跨会话发到自己 ClawTab session 后被 Gateway 回灌的 `clawtab_cmd` 回声。
  - 仅含 `thinking` 内容块、不含可读 text 的 assistant 消息（agent 内部推理 trace）。
  - 已有的 `clawtab_result` JSON 块、`/new` 指令也继续过滤。

- **"未响应"提示重置规则**：发出消息后若长时间没看到 agent 任何活动，UI 在底部显示一行红色提示。计时**不是"自发送起 60 秒"**，而是"自最近一次活动起 60 秒"——只要观察到 agent 仍在 perceive / act / 发新消息，超时就被推迟。这避免长任务（多步页面感知）刚开始就被误判为"agent 没响应"。

### 任务执行
- Agent 可触发 `perceive` / `act` / `task_start` / `task_done` / `task_fail` / `cancel` / `capabilities` 等命令。
- `capabilities` 命令让 agent 在会话中自查当前支持的 action / op / flag，不再需要读静态文档。
- 同一时间只允许一个 Agent 执行 `act` / `perceive`，其他请求会收到 `BUSY`。
- 任务进行中顶部任务栏显示状态（perceiving / thinking / acting / done / failed / cancelled）以及最近一次截图。
- **切换标签页不会触发任何面向 agent 的副作用**——不自动截图、不自动感知，只有 agent 明确下 `perceive` / `act` 命令、或用户在 DEV 面板里点按钮，才会调用 `chrome.tabs.captureVisibleTab`。

### 浏览器自动化工具面
- 批量表单填写 `fill_form` — 登录 / checkout 一次性灌 N 个字段。
- 多标签管理 `list_tabs` — 返回所有打开 tab 的 `{id, url, title, active, pinned, audible, muted, favIconUrl}`。
- URL 等待 `wait_for_url` — 点击后等跳转到指定 URL 模式（支持 `*` / `**` 通配）。
- 链接全量 `get_all_links` — 不受 `perceive.dom.interactive` 的 50 条上限，用于搜索结果 / 长文导航。
- 正文提取 `get_article_text` — 启发式读文章正文（`<article>` / `<main>` / 段落最密 section），纯文本输出。
- 快捷键组合 `press` — 支持 `ctrl+a` / `meta+shift+k` / `alt+Tab` 等修饰键组合。
- Shadow DOM 穿透 `pierceShadow: true` — `click` / `fill` / `clear` / `get_text` / `hover` / `scroll_to_element` 在遇到 `shadowRoot` 时递归查找。

### DEV 测试面板
- 仅在 `pnpm dev` 跑出来的开发构建里可见（生产 build 会被 tree-shake 掉）。
- 聊天页 TaskBar 下面一个折叠块，默认收起；展开后每个 op 一个按钮，按分组（meta / perceive / tabs / content / navigation / input / eval）列出。
- 点一下按钮就在当前 active tab 上执行，不经过 `chat.history`——测试调用不污染会话上下文。
- 结果区显示 ok/error + 耗时 + 截断到 3.5KB 的 JSON；若结果含 `data:image/...` 会自动渲染成缩略图。

### 双语 & 元素拾取
- 支持中英文切换（侧边栏左上角切语言按钮），偏好持久化。
- 切换按钮的 tooltip 始终用**当前 UI 语言**书写（英文界面写 "Switch to Chinese"，中文界面写 "切换到英文"），不夹杂另一种语言。
- 提供"元素拾取"模式，可在页面上挑选 DOM 元素并以 `#1: tag` 形式作为附件附在消息中。
- 元素拾取的视觉反馈与点击附件 tag 后的"高亮闪烁"必须使用**同一个浮层 DIV（页面级单例）**：
  - 浮层位置以**文档坐标**计算（`getBoundingClientRect + scrollX/Y`，`position:absolute`），页面滚动时浮层会随被高亮元素一起滚动，不再相对视口固定。
  - 点击附件 tag 触发的高亮动画播完一次（约 2.2s）后浮层必须真正隐藏，不允许出现"消失后又自动显现并永驻"的回闪。再次点击同一附件 tag 应能重新触发动画。

### 诊断日志
- 用户可以**一键导出会话记录**：
  - Chat 页面 header 提供下载图标按钮，连接成功后随时可点。
  - 导出文件是 `clawtab-session-<时间戳>.jsonl`：第一行是会话元数据 (`{ kind: 'session_meta', sessionKey, agent, browserId, exportedAt }`)，之后每行是一条原始 chat message (`{ kind: 'message', ... }`)。JSONL 方便追加和工具链消化（jq / 数据管道）。
  - 不再单独提供"清除日志"按钮——该功能已下线。
  - Config 页面表单底部仍保留"导出 / 导入配置"按钮。

## 非目标
- 不内置 Agent 推理能力，所有指令来自远端 Gateway 上的 Agent。
- 不做 OAuth / 账号体系，鉴权完全依赖 Gateway 颁发的 Token + 设备密钥。
- 不持久化对话内容，会话历史以 Gateway 为准。
