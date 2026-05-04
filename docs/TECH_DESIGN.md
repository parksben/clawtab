# ClawTab — 技术设计

> 记录 ClawTab 扩展的整体架构、关键设计选择以及"为什么这么做"。

## 技术栈

**React 19 + TypeScript 5 (strict) + Tailwind v3 + Vite 6 + @crxjs/vite-plugin v2**，pnpm 管理。

- **构建**：`pnpm build` 输出 `dist/`，`pnpm build:watch` 重复构建。生产产物自包含，可直接 `Load unpacked dist/`。
- **开发**：`pnpm dev` 启 Vite 开发服务器（端口 5173，`strictPort:true`）+ HMR；浏览器只需 Load unpacked `dist/` 一次。详见 `## 开发流程` 一节。
- **类型**：严格模式 TypeScript，共享类型放 `src/shared/types/`。
- **Markdown**：`marked` 走 npm import（Phase 4 完成）。
- **图标**：`lucide-react` 命名导入，禁止混用其它 icon 库。

## 开发流程

主路径就是 `pnpm dev`：

```bash
pnpm install        # 一次
pnpm dev            # 后台跑
# chrome://extensions/ → Load unpacked → dist/   （也只做一次）
```

之后改代码，每种文件的反应是：

| 编辑路径 | 反应 |
|----------|------|
| `src/sidebar/**` | sidepanel 内 React HMR，瞬时刷新，state 保留 |
| `src/background/index.ts` | 重新打包 → Chrome 自动 reload 整个扩展（`@crxjs` 监听 dist/manifest 变化触发）。SW 内存被清空，需要靠 `chrome.storage.local` 恢复（参见"Service Worker 易失性"一节） |
| `src/content/index.ts` | 同上 reload。**已经打开的 tab 需要手动刷新**才能装上新版本 content 脚本 |
| `src/manifest.ts` | 重新打包 → reload |

### 为什么 dev 模式下的 `dist/` 不能直接拿去发布

`pnpm dev` 写出的 `dist/manifest.json` 让 sidepanel HTML import `http://localhost:5173/...`，关掉 Vite 进程之后这个 dist 立刻失效。要发布或归档必须走 `pnpm build`。

### 为什么不用 `vite preview`

@crxjs 用 `chrome.runtime` 协议拼出 sidepanel 的 HMR client，这套是基于 Vite dev server 的特殊路径，`vite preview` 模式拿不到。所以工作流就一个：开发 `pnpm dev`，发布 `pnpm build`。

## 打包与发布

### 本地打 `.crx`

```bash
pnpm build && pnpm pack:crx
```

`scripts/pack-crx.mjs` 调 `crx3` 把 `dist/` 打成两个文件：`clawtab.crx` 和 `clawtab-{version}.crx`（前者方便 CI 写 release 链接，后者方便分发存档）。

### 签名 key 与扩展 ID 的关系

Chrome 把扩展 ID 算作 `manifest.json.key`（公钥）的 SHA-256 截断。**与 CRX 签名所用的私钥无关** —— 签名仅用于校验 CRX 完整性。所以我们的策略：

- 仓库 `manifest.ts` 里硬编码了一个公钥，对应固定 ID `olfpncdbjlggonplhnlnbhkfianddhmp`，所有用户加 `allowedOrigins` 用同一个 origin。
- CRX 签名私钥可以是任意值。`pack-crx.mjs` 按以下顺序找 key：
  1. `CLAWTAB_CRX_KEY` 环境变量（CI secret 用这条）
  2. 仓库根目录的 `key.pem`（已加入 `.gitignore`）
  3. 都没有就让 `crx3` 临时生成一个 —— 装上去仍然是同一个扩展 ID
- 想要"跨次构建签名一致"（比如未来上 update manifest），把同一个 RSA 私钥写进仓库 secret `CLAWTAB_CRX_KEY` 即可。

### CI 工作流

`.github/workflows/build.yml`，触发条件三种：

1. **push 到 main** —— typecheck + test + build + pack:crx，产物以 `clawtab-crx` 为名挂上 30 天 workflow artifact。GitHub Web 下载会包一层 zip，里面才是真正的 `.crx`，README 里写明了。
2. **push tag `v*`** —— 同样跑完前面，再用 `softprops/action-gh-release` 把 `.crx` 直接附到 GitHub Release。这个链接没有 zip 包装、不会过期。
3. **手动 dispatch** —— 用来重跑某个 commit 上的构建。

CI 用 Node 22 + pnpm 10，`actions/cache` 走 pnpm 内置 cache，整体一次跑约 1–2 分钟。

## 模块划分

| 路径 | 角色 |
|------|------|
| `src/background/index.ts` | Service Worker：管理 WebSocket、命令轮询、Tab 操作的统一入口（从 1590 行的 `background.js` 迁移而来，phase 3） |
| `src/content/index.ts` | 内容脚本：注入到所有页面，承担 DOM 元素拾取（phase 2） |
| `src/shared/types/` | 跨组件共享类型（messages / protocol / state / picker） |
| `src/manifest.ts` | `@crxjs/vite-plugin` 读取的 MV3 manifest 源 |
| `sidebar/sidebar.html`, `sidebar/sidebar.js`, `sidebar/sidebar.css` | **尚未迁移**，phase 4 会替换为 `src/sidebar/` 下的 React 组件树 |
| `shared/icons.js` | SVG sprite，phase 4 后会随 sidebar 一起退役 |

三者通过 `chrome.runtime.sendMessage` 通信，没有共享内存。所有消息体走 `src/shared/types/messages.ts` 的 discriminated union，加新消息类型时 TS 会在 `src/background/index.ts` 的 switch 里报穷举错误。

## 连接 / 配对流程

```
用户填配置 → WebSocket 连接 → Ed25519 challenge-response 握手
  → CLI `openclaw devices approve <id>` 完成配对
  → 持久化 deviceToken（下次直接复用）
  → 启动 chat.history 轮询（~3s）
  → 解析 ```json clawtab_cmd ``` → 执行 → 回写 clawtab_result
```

## 消息渲染与去重（重要）

侧边栏轮询 `chat.history` 拉取整段历史（最多 50 条）。这意味着每个轮询周期都会拿到大量"已经渲染过"的消息。如果 dedup 不可靠，UI 会出现"消息无限重复滚动"的现象。

### 设计决策：基于 `msgKey()` 的复合 key 去重

在 `fetchHistory()` 中维护一个 `seenKeys` Set，对每条返回的消息计算一个稳定的 key，已经存在的 key 直接跳过。

`msgKey(m)` 的优先级：

1. **`m.id` 优先**：Gateway 返回了消息 id 时，直接用 `id:<m.id>` 作为 key。这是最准确的方式。
2. **内容 + 角色兜底**：当 `m.id` 缺失（例如握手消息以 `idempotencyKey` 形式发送、Gateway 在 `chat.history` 中可能不返回稳定 id）时，回退到 `c:<role>|<content 前缀>`。

```js
function msgKey(m) {
  if (m.id) return `id:${m.id}`;
  return `c:${m.role}|${msgText(m).slice(0, 300)}`;
}
```

并且在循环里 `seenKeys.add(key)`，这样**同一次响应内**重复的消息也会被去重。

### 为什么不只用 `m.id`

历史教训：之前的 `e04e581` 已经做过纯 id 去重，但生产中仍出现握手消息无限重复刷屏。原因是握手消息 / 部分系统消息在 `chat.history` 中可能不带稳定 id，纯 id dedup 直接漏过。改成 id-or-content 的 key 之后，无论 Gateway 是否补 id，UI 都能稳定收敛。

### 为什么不每次 `renderAll()` 重建 DOM

`renderAll()` 会清空 `#messages` 再重建，会破坏用户当前的滚动位置和选区。坚持"freshMsgs 才 append"的增量渲染，前提是 dedup 必须万无一失，因此把所有保险都堆在 `msgKey` 这个函数里。

### 本地回显

发送消息时先 push 一条 `{ id: 'local-<ts>', role: 'user', ... }`。`fetchHistory` 通过比较 `msgText` 找到对应的服务端消息，**就地替换** `STATE.messages` 中的 local 项以及 DOM 节点，避免出现"local + server"两份。

## Service Worker 易失性

MV3 Service Worker 是临时进程：

- 内存中的 `STATE.*`、`processedCmds` Set、WebSocket 实例都会被清空。
- 因此关键进度全部用 `chrome.storage.local` 持久化：`lastSeenMsgId`、`hs_<sessionKey>`（握手已发送标记）、`deviceToken`、配置项等。

## 握手只发一次（重要）

握手消息（`🦾 ClawTab 已连接 ...`）通过 `chat.send` 发给 Agent，提示其加载 `clawtab_cmd` 协议。在生产中观察到的"握手被发两次"问题来自三处可被同时触发的副作用，本节明确规定它们的行为，避免再次回归。

### 三层防护

1. **持久化标记 `hs_<sessionKey>` 一旦写入就不撤销。**
   - 写入时机：`sendHandshake()` 进入 try 之前就 `chrome.storage.local.set({[hsKey]: true})`。
   - 失败时**不删除**：即使 `wsRequest('chat.send', ...)` 因为 WS 中途掉线、超时而 reject，本地标记保留。原因是 Gateway 可能其实已收到并入库，只是响应丢了；删除标记会让下一次重连再发一遍，触发 Agent 重复回复。
   - 唯一清除时机：用户切换到不同的 `sessionKey`（换 channel name，标记天然按 key 隔离）。即使是 `isNewSession=true`（Gateway 报告全新会话）也**不**清除 —— 否则 Gateway 端的状态抖动会被放大成用户可见的重复消息。

2. **进程内单飞锁 `_handshakeInFlight`。**
   - 防止单个 SW 进程内多个 `connect.ok` 处理函数并发触发 `sendHandshake`：典型场景是 WS 掉线后 `wsScheduleReconnect` 与原 connect-ok 的 `await` 链交错。
   - 进入函数立刻置 `true`，`finally` 重置为 `false`。SW 重启会清空，由第 1 层接力。

3. **进入函数后再读一次 storage 标记。**
   - 覆盖 SW 重启的那一瞬：旧进程刚把 `hs_*` 写入磁盘但还没发出 `chat.send` 就被杀，新进程启动后又走到 `sendHandshake`。再读一次磁盘标记即可识别"已经在处理中或已发出"，直接返回。

### 调用条件统一

`connect.ok` 处理函数里只有一处发握手的入口：

```js
const alreadySent = !!(await chrome.storage.local.get([hsKey]))[hsKey];
if (isNewSession) {
  S.lastSeenMsgId = null;
  await chrome.storage.local.remove([`lsid_${S.sessionKey}`]);
  // 注意：故意不清 hsKey
}
if (!alreadySent && !S.lastSeenMsgId) await sendHandshake();
```

不再像旧版本那样"`isNewSession` 分支无条件重发"，把 Gateway 状态的不确定性挡在客户端这一层。

### 副作用：极端情况下握手可能漏发

如果第一次发送真的失败（例如 Gateway 收到了但 wsRequest 抛错、且 Gateway 也确实没入库），按上述策略我们不会重试，Agent 会缺少协议上下文。这是显式权衡：用户可见的"重复回复"远比"少一次提示"刺眼，且用户可以通过换一个 channel name 重新发起握手。

### 清空上下文是握手重发的唯一入口

聊天输入框左侧的"清空上下文"按钮显式触发握手重发。流程在 `sidebar_reset_context` handler：

```
sidebar: 清 STATE.messages / DOM
  ↓ bg({type:'sidebar_reset_context'})
bg: chat.send('/new', deliver=true)      ← 让 agent 侧重置记忆
bg: storage.remove([hs_<sk>, lsid_<sk>]) ← 本地清标记与轮询游标
bg: sendHandshake()                       ← 标记已清，所以这次会真发
```

其他路径（connect.ok、reconnect、SW 重启）仍然按上面的三层防护保持"最多一次"。

## 清空上下文（`/new`）

聊天输入框左侧"新对话"按钮的完整 UX 与数据流：

1. **仅在已连接时可用**（按 `STATE.wsConnected` 联动 disabled，与拾取按钮的启用逻辑复用同一个 `updateStatus()`）。
2. **点击 → confirm**（国际化文案 `clearContextConfirm`）。用户确认后执行重置。
3. **sidebar 本地清理**：`STATE.messages`、`STATE.lastMsgId`、`STATE.pendingEchoContent`、`STATE.waiting` 一次性清掉；隐藏 thinking indicator；`renderAll()` 重绘为"空会话"占位态。
4. **调用 `sidebar_reset_context`**：由 background 负责三件事（保持原子 —— 前两步一个也不能漏）：
   1. `chat.send` 消息体 `"/new"`，`deliver:true`，由 Gateway 识别为 slash command 重置该 session。
   2. `chrome.storage.local.remove([hs_<sk>, lsid_<sk>])`。
   3. `sendHandshake()` 再走一遍（此时 hs 标记已清，`sendHandshake` 内部的 storage 再检查 → miss → 真发）。
5. **渲染过滤**：`/new` 自己会出现在 `chat.history` 里，但 `buildMsgNode` 和 `renderAll` 的 `visible` filter 都会跳过 `role === 'user' && text.trim() === '/new'`，不在 UI 上渲染这条"基础设施消息"。
6. 用户可见的结果：点完之后先是空白，短暂延迟后出现新的"🦾 ClawTab 已连接…"气泡 + agent 对握手的回复，工具立即可用。

### 为什么清空 UI 这一步必须走在 `/new` 之前

先清 UI + 先清 `lastMsgId`，意味着接下来 polling 拉回来的 `/new` 和新握手都会当成"新消息"去 append，而不是被旧的 seenKeys 拦下来。顺序反过来会看到"旧消息还在界面上、新握手被 dedup 掉"。

### `hiddenMsgKeys`：客户端永久过滤已清消息

Gateway 把 `/new` 当 agent 维度的"重置记忆"指令，**不会**因此从 `chat.history` 中删除任何旧消息。意味着 sidebar 把 `messages` 清空之后，下一轮 polling 拉回 50 条历史时，已清的旧消息会被当成"全新可见消息"重新 hydrate，UI 闪一下回到清空前的样子——这正是用户报告 [reducer.test.ts](../src/sidebar/state/reducer.test.ts)「`CLEAR_CONTEXT blocks gateway re-hydration`」中复现的 bug。

修复：reducer 维护一个 `hiddenMsgKeys: Set<string>`：

- `CLEAR_CONTEXT` 触发时把当前可见消息的 `msgKey` 全部塞进 `hiddenMsgKeys`，并把 pending echo 的内容键也加进去。
- `HYDRATE_HISTORY` 在 dedup 之前先用 `hiddenMsgKeys.has(k)` 过滤一道——已清的旧消息无论 polling 多少次都不会再回到列表。
- channel 切换 / agent 切换时清空这个集合（不同会话的 key 不可能重叠，留着只会成为后续误伤的隐患）。

副作用是：清空后如果新握手的 `msgText` 和某条旧握手碰巧一字不差（标签数恰好相等且 gateway 又没派发稳定 id），新握手会被一起过滤。实际场景里 tab 数 / 时间 / id 三个变量至少一个会变，单元测试覆盖了"内容相同但 id 不同"的正常路径。

### `hiddenMsgKeys` 跨次会话持久化

`hiddenMsgKeys` 必须**按 sessionKey 持久化**到 `chrome.storage.local`，键名 `hidden_<sessionKey>`，值是 `string[]`（Set 序列化）。

- 写入时机：`CLEAR_CONTEXT` 之后；reducer 是纯函数，所以由 `App.tsx` 的 effect 监听 `state.hiddenMsgKeys` + `state.channelName` 写盘。
- 读取时机：bootstrap 拉到 `status_update` 知道 `channelName` 后，立刻 `chrome.storage.local.get('hidden_<sk>')`，dispatch 一个 `HYDRATE_HIDDEN_KEYS` action 把它装回 reducer。这个 effect 必须在第一次 polling tick 之前执行，否则会有"恢复时间差"——我们用 `state.hiddenKeysHydrated` 标志位网住第一次 polling。
- 为什么必须持久化：`initialState()` 每次返回空 Set，sidepanel 关闭再打开后内存丢失，下一拍 `chat.history` 把已清的所有旧消息当成新消息 hydrate 回 UI，用户报"清空没生效"。
- 为什么按 sessionKey 隔离：不同 channel / agent 切换会重置 in-memory Set；持久化也按 key 隔离，避免一个 channel 的 blocklist 误伤另一个。
- 增长边界：单会话内最多积累几百条 keys（每条 ≤300 字符），10 KB 量级，远低于 5 MB 单 key 限额。换会话或重新 install 后自然清掉。

### 本地回显按 localId 精确替换

发送消息时 `APPEND_LOCAL_ECHO` 推一条 `{ id: 'local-<ts>', role:'user', content:<text> }` 到 `messages`，并把 `<localId, content>` 放进 `pendingEchoes: Map<string, string>`。下一拍 `HYDRATE_HISTORY` 拉到 server 端的同一条消息时，**通过 content 匹配命中对应 localId、再按 localId 替换具体的占位**，而不是"找第一个 local- 来替换"。

历史 bug：曾用 `pendingEchoContent: string | null` 单变量 + `messages.findIndex(m => m.id?.startsWith('local-'))`。当用户连发两条消息、轮询尚未追上时：

1. 第一条 `local-1` 仍在 `messages` 里
2. 第二条 push `local-2`，`pendingEchoContent` 被覆盖成第二条文本
3. 轮询返回 `[server-1 "Hi", server-2 "How are you"]`，`fresh.findIndex(m => msgText(m) === pendingEcho)` 命中 server-2
4. `messages.findIndex(... 'local-')` 返回 0（first local-）
5. **第一条占位被覆盖成 server-2 的内容**，UI 上第一条用户消息显示成第二条的文字

解决方法是 `pendingEchoes: Map<localId, content>`：每个 fresh user msg 在 map 里查找内容相同的 entry，按 entry 的 localId 在 messages 里精确替换那条占位（O(N) 但 N 很小）。匹配命中后从 map 里删掉这一项，避免下一次重复消费。

### 聊天可见性过滤（重要）

`chat.history` 拉到的消息不全部都该展示给用户。`selectVisibleMessages` 在 `/new` + `clawtab_result` 之外，还要过滤：

1. **`role === "toolResult"`**：agent 调 `web_fetch` / `sessions_send` / `sessions_history` 等工具的返回值，content 是大段 JSON dump，对用户没有阅读价值。
2. **`provenance?.kind === "inter_session"` 的 user 消息**：agent 通过 `sessions_send` 跨会话写到自己 ClawTab session，Gateway 把这条消息再回灌给原会话作为 user 消息（`provenance.sourceTool === "sessions_send"`）。这就是日志里看到的"clawtab_cmd 又作为 user 消息出现"的回声链。
3. **assistant 消息只有 `thinking` 块、没有可读 text 也没有 `tool_use` 块**：agent 的内部推理 trace。`msgText` 已经只取 `type === "text"` 块，所以这类消息 text 为空，selectVisibleMessages 自动会被过滤；但 `tool_use` 检查必须保留，否则混合 text+tool_use 的正常消息会被误伤。

`ChatMessage` 类型扩展可选字段 `provenance?: { kind?: string; sourceSessionKey?: string; sourceChannel?: string; sourceTool?: string }` 让 TS 能识别。

⚠️ **注意 inter_session 过滤必须在 `MessageBubble` 把 user 消息当 `clawtab_cmd` 渲染成 icon row 之前就拦住**——否则 perceive 中循环会让 chat 全是 perceive 图标行，比直接打印 JSON 更难看。

### 等待超时按活动重置

输入框送出消息后，App.tsx 启一个 60s 计时器，到点显示 "Agent did not respond within 60s"。**计时基线是"最近一次活动"，不是"send 时刻"**：

- 任何 `HYDRATE_HISTORY` 取回新可见消息（fresh 数组非空），重置计时器。
- `loop.status` 从 idle 变成 perceiving / thinking / acting，重置计时器。
- 收到 terminal 消息（`isTerminalMsg`），清掉计时器（waiting 同步置 false）。

这个改动避免一种典型误报：用户问"看下当前页面"→ agent 立刻发 `task_start`+`perceive` cmd → background 抓 DOM 截图 + 回 result → agent 边思考边发 `act`、`perceive` cmd …… 期间 assistant 消息全是 `clawtab_cmd` JSON 块（剥掉后无可见 text），原来的 terminal 判断永远不会触发，60s 一到就误报"agent 没响应"。改成"按活动重置"后，只要 agent 还在干活就不会冒红色 banner。

实现细节：把 `waitingTimerRef` 的启动 / 清除收敛到 App.tsx 的一个 effect 里，依赖 `state.waiting`、`state.messages.length`、`state.loop?.status`。任一变化都重新评估：waiting 为 false 就 clear，否则重启 60s 倒计时。

### Background 解析 chat.history 的三种 content 形态（重要）

历史 bug：background 的 `doPoll` 在提取 assistant 消息文本时只处理 `content: string` 和 `m.blocks`，没处理 `content: Array<{type,text}>`。Gateway 返回的实际形态恰恰主要是数组——所以 `clawtab_cmd` JSON 块永远 match 不到，**整个 perceive / act 链路从未在生产中跑通过**。导出的 chat 日志里清一色是 agent 发的 `clawtab_cmd` 但没有任何对应的 `clawtab_result`。

修复：抽两个共享 helper 在 background 顶部：

- `pickMsgText(m)`：依次尝试 `content` string → `content` array 的 text 块拼接 → `blocks` array 的 text 块拼接 → ""。
- `pickMsgId(m)`：`m.id || m.__openclaw?.id`。

为什么 `__openclaw.id` 必须兜底：Gateway 的 `chat.history` payload 经常省略顶层 `id`，把稳定 id 只放在 `__openclaw.id` 里。原来 `lastSeenMsgId = m.id` 这一句永远是 undefined → polling watermark 永远不前进 → 每次 polling 都从头扫一遍，要么 fast-forward 跳过新 cmd，要么重复处理（被 `processedCmds` set 兜住，但还是浪费）。

`pickMsgText` / `pickMsgId` 在 sidebar 也有平行版本：`msgText` 已经覆盖三种形态，`msgKey` 现在也按同样规则用 `__openclaw.id` 兜底。

防回归：`doPoll` 里加了一行 diag log，当 assistant 消息提取出空 text 时会打 `doPoll: assistant msg has no text` + content shape 摘要，导出诊断日志一眼就能看出新出现的 content 形态。

### processedCmds 必须持久化（重要）

原始实现里 `S.loop.processedCmds: Set<string>` 只在内存里。Chrome MV3 SW 默认 30s 无活动就被杀，下次 polling 拉到 chat.history 时 `processedCmds` 是空集，老 `clawtab_cmd` 又重新跑一遍——**每次重放都在当前 active tab 上 `captureVisibleTab`**，用户眼里看到的是"每切换一次 tab 都自动重新给 agent 发截图"。

修复：把 `processedCmds` 序列化成数组写到 `chrome.storage.local['processed_cmds']`（debounced 250ms），`init()` 里 `loadProcessedCmds()` 恢复。保留 300 条上限按 ring buffer 滚动。

组合效果：watermark (`lastSeenMsgId`) + dedup set (`processedCmds`) 双重持久化后，SW 休眠/重启不会再回放历史 cmd，跨会话 / 跨 Chrome 重启也同样稳定。

### `clawtab_result` 过滤：不能依赖 `JSON.parse` 成功（重要）

Gateway 对 `chat.history` 返回的消息做了 ~12KB 截断；感知截图是 JPEG base64，轻松超限。sidebar 原来的过滤代码 `JSON.parse(jsonMatch[1]).type === 'clawtab_result'` 在截断 payload 上抛错，catch 吞掉，消息 "keep"——于是 base64 全文直接灌进聊天列表。

修复：过滤改用 **正则** `"type"\s*:\s*"clawtab_result"`，不依赖 payload 完整性。测试 `"filters TRUNCATED clawtab_result blocks"` 锁住这一路径。

### Tab 切换不做任何"副作用"（用户要求）

历史实现：`chrome.tabs.onActivated` 里调 `captureQuickSnapshot()` 更新 TaskBar 缩略图。问题：
1. 每次切 tab 消耗一次 `chrome.tabs.captureVisibleTab` 配额（1/秒），后续合法 perceive 容易 rate-limit；
2. 用户感觉"切 tab 就有东西在后台动"，不直观。

修复：onActivated 只发 `tab_activated` 广播（供 sidebar 保存 draft）+ 清掉 pick mode，不再自动截图。截图只在 agent 明确要求（perceive/act captureAfter）或 DEV 测试面板点按钮时才发生。

### Dev 测试面板

`import.meta.env.DEV === true` 时，`ChatPage` 顶部显示一个 `DevPanel`（`src/sidebar/components/DevPanel.tsx`），每个 op 一个按钮 + 结果内联显示。**不走 chat.history**，通过三个新 bg 消息 `dev_run_act` / `dev_run_perceive` / `dev_capabilities` 直通 executeAct / extractDOM，避免污染会话。生产构建 (`pnpm build`) 里 `import.meta.env.DEV = false`，DevPanel 被 tree-shake 掉。

### 扩展的 `act` ops（补齐浏览器自动化能力）

这些是在 phase 4 之后新加的 op，填充常见 agent 工作流的空白：

| op | 目的 | 为什么需要 |
|----|------|-----------|
| `fill_form` | 批量填表 | 登录 / checkout 场景一次 N 个字段。逐个 `fill` 会 N×(gateway RTT + polling tick)，累积延迟难看。 |
| `list_tabs` | 列出所有 tab | 原来只暴露 `tabCount`，agent 无法引用"切到 github 那个 tab"。 |
| `wait_for_url` | 等 URL 匹配 | 点击登录 → 等 `/dashboard`。`wait_for` 是等元素，这一条是等导航完成。 |
| `get_all_links` | 一次拿全链接 | `perceive.dom.interactive` 限 50 条。长文章 / 搜索结果页经常 100+ 链接。 |
| `get_article_text` | 提取正文 | 读长文章。启发式：优先 `<article>` → `<main>` → 段落最密的 section。不引 readability 依赖。 |
| `press` 修饰键 | `ctrl+a` / `meta+shift+k` | 页面级 JS 快捷键处理（注：DOM 事件无法触发浏览器 chrome 级快捷键，像 `Ctrl+T` 开新 tab 需要用 `new_tab` op）。 |
| `pierceShadow` flag | 穿透 shadow DOM | 现代 Web Components (Stripe、Shopify 组件、某些 DevTools) 把元素藏在 `shadowRoot`，`querySelector` 够不到。 |

新 op 的实现全部在 `executeAct` switch 里，`handleAct` 把 `payload.fields` / `payload.pierceShadow` 透传进去。`describeOp` 也要同步更新（否则 UI 显示成 "undefined"）。

### `capabilities` action

agent 可以通过 `capabilities` 自查可用 action / op / flag / 当前浏览器状态，不再依赖静态文档。返回数据结构见 `AGENT_PROTOCOL.md`。当我们将来删除或重命名 op 时，agent 能通过比对 `capabilities` 与本地期望优雅降级。

### 截图压缩（`shrinkScreenshot`）

Chrome 的 `chrome.tabs.captureVisibleTab` 按视口原分辨率生成 JPEG，base64 后单张约 100–200 KB。几次 perceive 就能把 agent 上下文推到 1M token 上限触发 `400 prompt is too long`（线上实测 1.29M tokens），agent 的下一条消息直接 stopReason=error + 空 content。

修复：background 顶部 `shrinkScreenshot(raw, maxDim=1024, quality=0.42)` helper：

1. `createImageBitmap(dataURLToBlob(raw))` 拿到 bitmap
2. 如果最长边 > `maxDim`，按比例缩到 `maxDim`
3. `OffscreenCanvas` + `drawImage` 重绘到目标尺寸
4. `canvas.convertToBlob({ type:'image/jpeg', quality: 0.42 })` 重编码
5. `blobToDataURL` 输出

调用点：
- `handlePerceive` 拿到原始截图后立刻 shrink；`S.loop.lastScreenshot` 也存 shrink 后版本，TaskBar 缩略图复用
- `handleAct` 的 `captureAfter` 截图同样 shrink
- DEV 面板的 `dev_run_act` / `dev_run_perceive` 也走 shrink

单张输出降到 ~15–30 KB，比原来小 ~5x，agent 上下文预算回到可控区。`screenshot_element` 故意**不**走 shrink：它的 payload 是"完整 tab 截图 + 元素 rect"，agent 自己按 rect 坐标裁，缩放会让坐标失效。

失败时 fallback 原图并记 warn log，避免把 perceive 玩坏。

### DevPanel 开关（`import.meta.env.DEV` + storage 双通道）

`import.meta.env.DEV` 只在 `pnpm dev` 跑 Vite 开发服务器时为 true；直接 load-unpacked `dist/` 的生产产物拿到的是 `false`，DevPanel 被 tree-shake 掉。对于希望在任意构建里手动打开面板的开发者，加一条 storage 通道：

- `chrome.storage.local['devTools'] === true` 时也渲染 DevPanel
- Config 页面底部一个 "Enable developer test panel" checkbox，打勾 = 写 storage，效果即时（storage 监听）
- 两个来源通过 `useDevToolsEnabled()` hook 汇合：`import.meta.env.DEV || storageOn`

storage 通道带来的副作用只影响 UI 可见性，不影响协议或 bg 行为——DevPanel 本身调用的 `dev_run_act` / `dev_run_perceive` / `dev_capabilities` 在任何构建里 bg 都接收，所以不需要同步 gating。

### 连接按钮的 loading 状态

原来 ConfigPage 直接调 `bg.connect()`，没 dispatch `CONNECT_STARTED` → `state.connecting` 永远不变 true → 按钮没 loading、可以二次点击。

修复：把 bg.connect 抬到 App 层的 `handleConnect`：

```
handleConnect(url, token, name):
  dispatch CONNECT_STARTED   // state.connecting=true, 按钮立刻 disabled + spinner
  try await bg.connect(...)
  catch: dispatch CONNECT_FAILED  // 回到可点击状态
```

ConfigPage 新增 `onConnect` prop 调这个 handler。`state.connecting` 后续由 `STATUS_UPDATE` 的 `s.reconnecting && !s.gaveUp` 条件维持，直到 `wsConnected` / `pairingPending` / `gaveUp` 其中一个变 true 才清掉——完整走完 WS 握手才解锁按钮。

## 链接打开方式

聊天气泡里的 markdown 链接（裸 URL 或 `[text](url)`）通过两层处理保证"点击 = 在新标签打开"：

1. `sanitizeHtml()` 把所有 `<a>` 强制改写为 `target="_blank" rel="noopener noreferrer"`，并去掉任何已有的 target / rel。
2. `#messages` 容器上挂一个 click 委托，对 `http(s)://` 链接 `preventDefault` 后调用 `chrome.tabs.create({ url, active: true })`。

只用 `target="_blank"` 在 sidepanel 中并不可靠（部分 Chrome 版本会无声吞掉、或试图把 sidepanel 自身导航走），所以两层都要保留。click 委托的 `preventDefault` 也避免了同时触发"target 跳转 + tabs.create"导致重复打开。

## UI 约定

- **双页结构**：Config / Chat，由 `status_update` 消息驱动切换。
- **Chat 页面布局（不可回归）**：`ChatPage` 是 `flex h-full flex-col`，header / TaskBar / 输入框是固定高度，中间的 `MessageList` 包裹层用 `flex-1 overflow-hidden`，**`MessageList` 自身的滚动容器必须挂 `h-full` 和 `overflow-x-hidden`**——否则容器会随消息长度无限撑高，溢出被父层 `overflow-hidden` 裁掉，UI 表现为"消息被输入框压住、滚不动"或"出现横向滚动条"。
- **消息排版**：用户消息保持气泡（`bg-brand`、靠右、`max-w-[calc(100%-120px)]`），Agent 回复**不带气泡**——直接渲染 `.md-bubble` 占满容器宽度。`.md-bubble`、`.md-bubble pre` 都强制 `overflow-wrap: anywhere` + `word-break: break-word`，长 URL / hash / 单行代码全部强制断词，避免被推爆容器。
- **输入框自适应高度**：`InputArea` 的 textarea 没有 `max-h`，每次内容变更后用 `el.scrollHeight` 重设 `style.height`；textarea 自己加 `overflow-hidden` 防止任何场景下出现内部滚动条。父容器是 `flex items-end`，左右按钮永远贴着 textarea 底边。
- **导出会话**：Chat 页面 header 右上角的下载按钮调用 `bg.fetchHistory(sessionKey)` 并把返回值写成 `clawtab-session-<时间戳>.jsonl`（第一行 `kind: 'session_meta'`，后续每行一条 raw chat message）。原"导出诊断报告 / 清除日志"两枚按钮已下线；后台的 `diag_get` / `log_clear` 协议保留，便于将来再开调试入口。
- **i18n**：所有可见字符串通过 `data-i18n` 属性 + `applyI18n()`，禁止直接对 `statusText` 等元素 `textContent =`。`applyI18n` 同时支持 `data-i18n-ph`（placeholder）和 `data-i18n-title`（title 提示）。
- **Toolbar 图标**：稳定状态用 PNG，瞬时状态（connecting / perceiving / thinking / acting / failed）用 canvas 现场绘制带颜色的"C"角标。

## 诊断日志（重要）

`background.js` 是日志唯一的写入与持久化点，sidebar / content 通过 `chrome.runtime.sendMessage({type:'log_event'})` 单向推送，由 background 落到统一的 ring buffer。这样无论是哪条上下文产生的事件，最终都汇聚到一个有序时间线，导出时不需要做合并。

### 数据结构

```js
S.logs: Array<{ t: number, level: 'info'|'warn'|'error', src: 'bg'|'sidebar'|'content', msg: string, data?: string }>
```

- `LOG_CAP = 500`，超出时从前面 splice，标准 ring buffer。
- `data` 字段是 `safeSerialize()` 处理过的 JSON 字符串：循环引用降级为 `[circular]`、单字段超过 `LOG_DATA_MAX_CHARS` (600) 自动截断，整个序列化结果再加一道总长上限。**这是为了防止把整张截图 base64 写进日志撑爆 storage**。

### 持久化策略

- `loadLogs()` 在 SW init 时一次性从 `chrome.storage.local.get('diag_logs')` 恢复。
- 每次 `logEvent` 写入后调用 `persistLogsSoon()`：250 ms 防抖写盘。SW 被杀的极端情况下可能丢最近 250 ms 内的日志，但避免了对 storage 的高频写。
- `chrome.storage.local` 单 key 容量 5 MB，500 条 × ≤1.2 KB ≈ 600 KB 上限，留足余量。

### 导出流程

`sidebar` 触发 → `bg({type:'diag_get'})` → background 当场拼装 bundle：

| 字段 | 来源 |
|------|------|
| `state` | `S` 中的连接状态 + loop 状态（最近 16 条 history） |
| `config` | `chrome.storage.local.get(['gatewayUrl','gatewayToken','browserName','deviceToken','manualDisconnect'])`，**先经 `redactConfig()` 抹掉 token / secret / password / key 字段，只保留前 4 + 后 2 字符 + 长度** |
| `logs` | `S.logs.slice()`（直接拷自内存，避开 250 ms 防抖窗） |
| `chatHistory` | 临时打一次 `chat.history` (limit 50)，未连接时为空数组 |

sidebar 拿到 bundle 后由 `formatDiagBundle()` 拼成可读纯文本，浏览器原生下载。

### 为什么不直接共享 `chrome.storage.local`

- 三方上下文（content / sidebar）写 storage 会绕过 `safeSerialize` 的截断逻辑；统一走 background `logEvent` 才能保证 ring buffer 大小可控。
- background 顺带做了 console mirror，开发期间在 SW devtools 里能直接看到，无需先导出再翻文件。

### redactConfig 的覆盖范围

`/token|secret|password|key/i` 命中即 redact。这是宁可错杀的策略，新加配置项时如果命名带这些字眼会被自动遮蔽，避免遗漏导致 token 流出到用户分享的日志包里。

## 已知坑（汇总自 DEVELOPMENT.md）

参见根目录 `CLAUDE.md` 的 "Key Pitfalls" 段，覆盖了 DOM 缓存、握手幂等、`status_update` 状态清理、Ed25519 payload 等关键点。

## 元素拾取浮层（共享单例）

页面上**只有一个**浮层 DIV `#__clawtab_overlay__`，由 `src/content/index.ts` 创建并复用。它同时承担两件事：

1. **拾取模式 hover 高亮**：`enter_pick_mode` 时，监听 `mousemove` 把浮层挪到鼠标下元素的位置；`exit_pick_mode` 时把浮层 `display:none`，但**不销毁** DIV，下次直接复用。
2. **附件 tag 闪烁**：sidebar 里点击 attachment chip → 经 background 转发 `flash_element` 到当前 tab content script → 在同一个浮层上播一次淡入/保持/淡出的 CSS keyframe 动画。

### 为什么是单例 + position:absolute + 页面坐标

老实现里，picker hover 用 content script 创建/销毁 `__clawtab_pick_hl__`，flash 用 background 注入脚本里的 `__ct_flash_ov__`，两个不同 DIV，全部用 `position:fixed` + 视口坐标。结果：

- 视口坐标在用户**不动鼠标只滚轮**时不会重新计算，浮层粘在视口、跟实际元素脱节。
- 两套实现彼此不感知，一个在播动画的同时另一个可能还残留在 DOM 里。

新实现统一为：
- `position:absolute` + `rect.* + window.scrollX/Y` 写入 `top/left`，浮层挂在 `documentElement` 上 → **页面滚动时浮层和元素一起走**。
- 单例 DIV 只创建一次（`document.getElementById('__clawtab_overlay__')` 命中即复用），销毁的代价让位给"display 切换 + animation 重置"。

### flash 动画的正确收尾（关键坑）

之前的 bug：动画 `forwards` 让浮层 2.2s 时停在 `opacity:0`，但代码在 2.4s 又把 `animation` 设成 `'none'`，computed `opacity` 回到默认 `1`，浮层"复活"且永远不消失。

正确做法：动画结束后改 `display:none`（**不要**清掉 `animation`）。下次再 flash 时：`display:block` → 重设 `top/left` → `animation:none` + `void offsetWidth` 强制 reflow → 重新挂上 keyframe `animation` 即可重新播放。这样：
- 动画跑完真的看不见浮层；
- 同一附件多次点击仍然能看到完整的淡入/保持/淡出。

### 为什么 flash 的实际渲染落在 content script 而不是 background

要复用单例 DIV，且要让 `getBoundingClientRect` + `window.scrollX/Y` 拿到正确的页面坐标，最自然的位置就是 content script。所以 background 的 `flash_element` 现在只做一件事：`chrome.tabs.sendMessage(activeTabId, { type: 'flash_element', selector })`，把工作交给 content。

---

## 迁移路线：React + TypeScript + Tailwind + Vite

项目当前是纯原生 JS（~4500 LOC，无构建步骤）。这一节记录向 React/TS/Tailwind/Vite 技术栈迁移的 **10 阶段路线图**，以及每个阶段的范围与退出条件。

### 关键原则

1. **用户不可见变更之前的每一步都是 docs-first**：先更 `REQUIREMENTS.md` / `TECH_DESIGN.md`，后改代码。
2. **每个 phase 结束都是可加载、可运行的扩展**：
   - Phase 1 起 `pnpm build` 产出 `dist/`，`Load unpacked → dist/` 可用。
   - 根目录旧文件**一直保留到 Phase 7**，所以老方式（直接 Load unpacked 仓库根目录）在迁移中途仍然能跑，GitHub zip 下载链接不会断。
3. **关键不变式原样搬运**（CLAUDE.md 的 Key Pitfalls 与本文件前面小节的设计）：
   - 握手三层防护（进程锁 + storage 标记 + 进入后再检查），错误时绝不删标记。
   - `connect.ok` 单 gate `!alreadySent && !lastSeenMsgId`，`isNewSession=true` 分支不清握手标记。
   - `fetchHistory` 的 `msgKey` 去重（id 优先 + content fallback）。
   - `isHiddenInfraMsg` 过滤 `/new`。
   - 链接通过 `chrome.tabs.create` 打开，不能仅靠 `target="_blank"`。
   - SW 易失性 + `chrome.storage.local` 持久化策略。
4. **Lucide-only**：用 `lucide-react` 命名导入，禁止混入其他 icon 库。
5. **小步提交**：每个 phase 一次 `git push`，README 的 zip 下载链接随时可用。

### 技术栈决定

- **Vite 6** + `@vitejs/plugin-react` + **`@crxjs/vite-plugin@^2.0.0-beta`**：目前唯一能正确处理 MV3 Service Worker `type:"module"` + sidepanel 的构建方案，替代品（rollup-plugin-chrome-extension）已停维护。
- **React 19** + **TypeScript 5.6 strict**。
- **Tailwind v3**（不上 v4 —— 扩展场景里 v4 的 CSS layer 语义仍有 quirks）。
- **lucide-react**：tree-shake 友好，命名导入。
- **状态管理**：`useReducer` + 一个 Context 就够，不上 Zustand/Redux —— state 拆下来约 8–12 个 action。
- **Tooltip**：自研 ~50 行（`position:fixed` + `getBoundingClientRect()` + 边缘翻转），不引 radix-ui（sidepanel 包体敏感）。
- **测试**：只对 `reducer.ts` / `msgKey` / `isHiddenInfraMsg` / `safeSerialize` 这几个纯函数加 Vitest，防止"握手重复"那类 bug 回归。不写组件测试。

### 阶段节奏

| Phase | 范围 | 状态 |
|-------|------|------|
| 0 | **docs-only**：路线图与原则写入 `TECH_DESIGN.md`。 | ✅ |
| 1 | **脚手架**：`package.json` / `tsconfig.json` / `vite.config.ts` / `src/manifest.ts` / `.gitignore`。`@crxjs` 指向当时还在根目录的 `background.js` / `sidebar/*` / `content/*` / `shared/*`。 | ✅ |
| 2 | **`content.js` + `src/shared/types` 迁 TS**。 | ✅ |
| 3 | **`background.js` 迁 TS**（单文件 `src/background/index.ts`，~14 个 SECTION 旗标保留为注释分隔，方便后续按需 split）。`enter_pick_mode` 重新注入路径改用 `chrome.runtime.getManifest().content_scripts[0].js[0]` 拿运行时哈希路径。 | ✅ |
| 4 | **接入 React + Tailwind + 完整重写 sidebar**：`src/sidebar/{App,main,index.html,styles.css,i18n.ts,components/*,hooks/*,lib/*,state/reducer.ts}`。删除 `sidebar/` 与 `shared/`。`vite.config.ts` 退役 `passThroughLegacyFiles`，加 `@vitejs/plugin-react` + `@` alias。`manifest.side_panel.default_path = 'src/sidebar/index.html'`。 | ✅ |
| 5 | **Vitest 覆盖纯函数**：`message-utils`（msgKey / msgText / isHiddenInfraMsg / extractJsonBlock / extractToolCalls / isTerminalMsg）+ `reducer`（page routing / HYDRATE_HISTORY 三类 dedup / local-echo 替换 / waiting-flag 切换）。共 36 测试。 | ✅ |
| 6 | **UI 改进：Tooltip 原语 + 所有 icon-only 按钮的 tooltip + Globe 语言切换**。`<IconButton>` 把 `tooltip` 设为必填 prop，所有调用位都不能漏。语言切换 tooltip 显示**目标语言**（`Switch to 中文` / `Switch to English`）。这一块和 Phase 4 一并落地。 | ✅ |
| 7 | **收尾**：README 改成 `pnpm install && pnpm build` + Load unpacked `dist/`；`CLAUDE.md` 删掉所有"vanilla JS / 双工作流"残影；本路线图改为完成态。 | ✅ |

### 当前架构注记

- 整个 `src/` 树 100% TypeScript。根目录除了 `docs/` / 构建配置 / icon PNG / `manifest.ts` 已经没有业务代码。
- Service Worker 仍是单文件 `src/background/index.ts`（~2.5K 行）。SECTION 注释分隔块原样保留 —— 当未来需要拆模块时（典型是 `ws.ts` / `poll.ts` / `handlers/{perceive,act,task}.ts` / `handshake.ts` / `messages.ts` / `tabs.ts`），这些 banner 直接对应文件边界。在拆之前不要拆，因为单文件让 Phase 3 的"原样搬运"风险最低。
- Sidebar 的状态完全在 [src/sidebar/state/reducer.ts](../src/sidebar/state/reducer.ts) 这一个 reducer 里，只暴露 ~24 个 action。所有副作用（chrome.runtime / 计时器）都在 `App.tsx` 的 effect 里执行。这意味着握手 dedup 和"清空上下文"那两个反复出 bug 的流程，每条状态线都在 [src/sidebar/state/reducer.test.ts](../src/sidebar/state/reducer.test.ts) 里挂着回归测试。
- Tailwind v3 + `lucide-react`。`src/sidebar/styles.css` 只有 `@tailwind base/components/utilities` 三层 + 一段 `.md-bubble` markdown 组件样式。

### 关于 zip 下载链接

`https://github.com/parksben/clawtab/archive/refs/heads/main.zip` 仍然可用，**但解压之后需要 `pnpm install && pnpm build`，然后 Load unpacked 解压出的 `dist/`** —— 不再像 Phase 0–6 那样"根目录直接可加载"。README + CLAUDE.md 都已经写明这一点。

### 风险与开放问题

1. **`chrome.sidePanel` HMR 未必稳定**：Vite 的 HMR WebSocket 可能跟 sidepanel 的 CSP + @crxjs 注入的桥 iframe 合不来。退路：`vite build --watch` + 手动 reload 扩展，仍是一次点击。
2. **SW module quirks**：`type: "module"` 下 Chrome 对相对路径和 `import()` 很敏感，所有 SW 代码只用 top-level 静态 import。
3. **Tailwind 动态 class 被 purge**：所有条件 class 必须走 `clsx(...)`，禁止字符串拼接（如 `\`bg-${color}\``）。
4. **content.js 不能用 Tailwind**：host 页面没加载 Tailwind CSS，`content/` 下的所有样式必须保留为 inline `cssText` 或 `element.style.*`。
5. **lucide-react 必须命名导入** `{ Globe }`，禁 `import * as Icons`，否则 tree-shake 失效。
6. **IndexedDB 数据库名 `clawtab-v2` 不能改**：否则现有用户的 Ed25519 设备密钥丢失、会被迫重新配对。
