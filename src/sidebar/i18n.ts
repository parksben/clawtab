// Minimal runtime i18n — two locales hard-coded for now.
// Swap later for react-intl if we grow a third language.

export type Lang = 'en' | 'zh';

export const STRINGS = {
  en: {
    // ── Config page ──
    connectTitle: 'Connect OpenClaw',
    configTitle: 'Connection Settings',
    gatewayUrl: 'Gateway URL',
    gatewayUrlPh: 'wss://your-gateway.example.com',
    token: 'Access Token',
    tokenPh: 'Paste your token here',
    channelName: 'Channel Name',
    channelNamePh: 'e.g. browser-home',
    channelNameHint: 'A unique name to identify this browser',
    connect: 'Connect',
    connecting: 'Connecting…',
    disconnect: 'Disconnect',
    exportConfig: 'Export config',
    importConfig: 'Import config',
    importSuccess: 'Config imported!',
    importError: 'Invalid config file',
    connFailed: 'Connection failed — check your settings',
    pairingTitle: 'Pairing required',
    pairingDesc: 'Send this pairing code to your OpenClaw agent:',
    pairingOr: 'Or run on your Gateway:',
    pairingCancel: 'Cancel',
    pairingCopy: 'Copy pair command',
    taskCancel: 'Cancel Task',
    toggleToken: 'Show/hide token',

    // ── Chat page ──
    connected: 'Connected',
    disconnected: 'Not connected',
    reconnecting: 'Reconnecting…',
    placeholderOn: 'Message… (⌘/Ctrl+Enter to send)',
    placeholderOff: 'Connect OpenClaw to start chatting',
    placeholderReconnecting: 'Reconnecting, please wait…',
    emptyConnect: 'Connect OpenClaw to start chatting',
    emptyChat: 'Send a message to {agent} to start chatting',
    sendMessage: 'Send message',
    pickElement: 'Pick an element on the page',
    openFullScreenshot: 'Open full screenshot',
    dismissLightbox: 'Close',

    // ── Loop status texts ──
    loopIdle: 'Ready',
    loopPerceiving: 'Analyzing page…',
    loopThinking: 'Thinking…',
    loopActing: 'Executing…',
    loopDone: 'Task complete',
    loopFailed: 'Task failed',
    loopCancelled: 'Cancelled',

    // ── Diagnostics ──
    exportLogs: 'Export logs',
    exportSession: 'Export session',
    clearLogs: 'Clear logs',
    clearLogsConfirm: 'Clear all diagnostic logs on this browser?',
    logsCleared: 'Logs cleared',
    exportFailed: 'Failed to export logs',

    // ── Clear context ──
    clearContext: 'New conversation (clear context)',
    clearContextConfirm: 'Clear this conversation and reset the agent context?',
    clearContextFailed: 'Failed to reset context',

    // ── Language switch tooltip — written in the CURRENT UI language. ──
    langSwitchTo: 'Switch to Chinese',
  },
  zh: {
    connectTitle: '连接 OpenClaw',
    configTitle: '连接配置',
    gatewayUrl: 'Gateway 地址',
    gatewayUrlPh: 'wss://your-gateway.example.com',
    token: '访问令牌',
    tokenPh: '粘贴令牌',
    channelName: '渠道名称',
    channelNamePh: '例：browser-home',
    channelNameHint: '唯一标识当前浏览器的名称',
    connect: '保存并连接',
    connecting: '连接中…',
    disconnect: '断开连接',
    exportConfig: '导出配置',
    importConfig: '导入配置',
    importSuccess: '配置已导入！',
    importError: '无效的配置文件',
    connFailed: '连接失败，请检查配置',
    pairingTitle: '需要配对',
    pairingDesc: '将配对码发送给 OpenClaw Agent：',
    pairingOr: '或在 Gateway 上运行：',
    pairingCancel: '取消',
    pairingCopy: '复制配对命令',
    taskCancel: '取消任务',
    toggleToken: '显示/隐藏令牌',

    connected: '已连接',
    disconnected: '未连接',
    reconnecting: '重连中…',
    placeholderOn: '发消息… (⌘/Ctrl+Enter 发送)',
    placeholderOff: '请先连接 OpenClaw',
    placeholderReconnecting: '重连中，请稍候…',
    emptyConnect: '请先连接 OpenClaw',
    emptyChat: '向 {agent} 发消息，开始对话',
    sendMessage: '发送消息',
    pickElement: '在页面上拾取元素',
    openFullScreenshot: '放大查看截图',
    dismissLightbox: '关闭',

    loopIdle: '就绪',
    loopPerceiving: '正在分析页面…',
    loopThinking: '思考中…',
    loopActing: '正在执行操作…',
    loopDone: '任务完成',
    loopFailed: '任务失败',
    loopCancelled: '已取消',

    exportLogs: '导出日志',
    exportSession: '导出会话记录',
    clearLogs: '清除日志',
    clearLogsConfirm: '确定要清除浏览器里所有诊断日志吗？',
    logsCleared: '日志已清除',
    exportFailed: '导出日志失败',

    clearContext: '新对话（清空上下文）',
    clearContextConfirm: '清空当前对话并重置 Agent 上下文？',
    clearContextFailed: '清空上下文失败',

    langSwitchTo: '切换到英文',
  },
} as const;

export type I18nKey = keyof (typeof STRINGS)['en'];

export function t(lang: Lang, key: I18nKey): string {
  return STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? (key as string);
}
