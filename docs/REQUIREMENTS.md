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
- 连接建立后，扩展会自动向会话发一条"握手提示"消息（提示 Agent 加载协议手册），握手消息**只发送一次**，不会因为 Service Worker 重启或重连而重复。
- **消息列表不应出现重复**：同一条消息（包括握手消息、Agent 回复、用户消息）只会在聊天列表中渲染一次，无论后台轮询了多少轮 `chat.history`。
- 工具调用 / `clawtab_cmd` 以紧凑的图标行展示；`clawtab_result` 对用户隐藏。

### 任务执行
- Agent 可触发 `perceive` / `act` / `task_start` / `task_done` / `task_fail` / `cancel` 等命令。
- 同一时间只允许一个 Agent 执行 `act` / `perceive`，其他请求会收到 `BUSY`。
- 任务进行中顶部任务栏显示状态（perceiving / thinking / acting / done / failed / cancelled）以及最近一次截图。

### 双语 & 元素拾取
- 支持中英文切换（侧边栏左上角切语言按钮），偏好持久化。
- 提供"元素拾取"模式，可在页面上挑选 DOM 元素并以 `#1: tag` 形式作为附件附在消息中。

## 非目标
- 不内置 Agent 推理能力，所有指令来自远端 Gateway 上的 Agent。
- 不做 OAuth / 账号体系，鉴权完全依赖 Gateway 颁发的 Token + 设备密钥。
- 不持久化对话内容，会话历史以 Gateway 为准。
