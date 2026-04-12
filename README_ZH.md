# ClawTab

> English docs: [README.md](./README.md)

**ClawTab** 是一个 Chrome 扩展，将你的浏览器连接到 [OpenClaw](https://github.com/openclaw/openclaw) Gateway，让 AI Agent 能够感知和控制浏览器标签页。

## 核心亮点

- **侧边栏直连 AI** — 点击图标打开侧边栏，直接与 Agent 对话；连接配置、聊天、任务控制全在一处
- **Agent 全自动操控浏览器** — Agent 可感知页面内容、自动点击 / 填表 / 导航，结果实时回传
- **任务全程可见** — 任务运行时顶栏显示目标、当前步骤及实时截图缩略图，点击可全屏查看
- **多 Agent 支持** — 侧边栏可切换不同 Agent，每个 Agent 维护独立会话和聊天历史

## 快速开始

### 1. 安装扩展

1. 下载：**[clawtab-main.zip](https://github.com/parksben/clawtab/archive/refs/heads/main.zip)**
2. 解压，打开 `chrome://extensions/`，开启右上角**开发者模式**
3. 点击**加载已解压的扩展程序** → 选择解压后的文件夹

### 2. 配置 Gateway

在安装了 OpenClaw Gateway 的机器上执行：

```bash
curl -fsSL https://raw.githubusercontent.com/parksben/clawtab/main/scripts/setup-gateway.sh | bash
```

脚本会自动定位配置文件，将 ClawTab 的扩展 origin 写入 `allowedOrigins`，并重启服务。执行前会自动备份原始配置。

> **手动配置：** 将以下 origin 添加到 `gateway.controlUi.allowedOrigins`，然后执行 `systemctl restart openclaw-gateway`。
> ClawTab 的 Extension ID 是固定的，所有用户添加的 origin 相同：
>
> ```
> chrome-extension://olfpncdbjlggonplhnlnbhkfianddhmp
> ```

### 3. 连接

1. 点击工具栏中的 **ClawTab** 图标 — 侧边栏打开
2. 填写 **Gateway URL**、**Access Token** 和**渠道名称**
3. 点击 **Connect** — 侧边栏自动切换到聊天页

Web UI 中可找到 `agent:main:clawtab-{渠道名称}` 会话。

## 隐私与安全

ClawTab 仅连接到你明确配置的 Gateway 地址，不向任何第三方服务发送数据。

## License

MIT
