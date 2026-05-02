# ClawTab — 技术设计

> 记录 ClawTab 扩展的整体架构、关键设计选择以及"为什么这么做"。

## 技术栈

- **纯原生 JS**：无构建步骤、无 npm、无 framework。Chrome MV3 直接加载。
- **唯一 vendor 依赖**：`marked.js`（v15.0.12，bundle 在 `sidebar/lib/`）用于 markdown 渲染。
- **图标**：`shared/icons.js` 内置 Lucide SVG sprite，UI 内任何图标都用其中的 `<use href="#icon-xxx">`。

## 模块划分

| 文件 | 角色 |
|------|------|
| `background.js` | Service Worker：管理 WebSocket、命令轮询、Tab 操作的统一入口 |
| `sidebar/sidebar.js` | 侧边栏 UI（Config + Chat 双页），消息渲染、用户输入 |
| `content/content.js` | 内容脚本：注入到所有页面，承担 DOM 元素拾取 |
| `shared/icons.js` | 跨组件共享的 Lucide 图标 sprite |

三者完全隔离，仅通过 `chrome.runtime.sendMessage` 通信，没有共享内存。

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
- `sendHandshake()` 必须**先**写 `hs_<sessionKey>` 标志再调用 API，否则 SW 在握手发送中途重启会触发重复握手（这一条同时是 dedup 不可靠时的二级保险，但不能依赖它）。

## UI 约定

- **双页结构**：Config / Chat，由 `status_update` 消息驱动切换。
- **i18n**：所有可见字符串通过 `data-i18n` 属性 + `applyI18n()`，禁止直接对 `statusText` 等元素 `textContent =`。
- **Toolbar 图标**：稳定状态用 PNG，瞬时状态（connecting / perceiving / thinking / acting / failed）用 canvas 现场绘制带颜色的"C"角标。

## 已知坑（汇总自 DEVELOPMENT.md）

参见根目录 `CLAUDE.md` 的 "Key Pitfalls" 段，覆盖了 DOM 缓存、握手幂等、`status_update` 状态清理、Ed25519 payload 等关键点。
