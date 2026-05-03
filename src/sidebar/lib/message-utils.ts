// Chat-message dedup + render helpers. Pure functions, no React — so they're
// testable and portable. The load-bearing invariants (docs/TECH_DESIGN.md):
//   - msgKey() uses m.id when present, otherwise a role+content hash. This
//     covers gateway messages without a stable id (handshake echo).
//   - isHiddenInfraMsg filters "/new" reset commands from the timeline.

import type { ChatMessage } from '@/shared/types/protocol';

export interface ToolCall {
  type: 'tool_use';
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export function msgText(msg: ChatMessage): string {
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c))
    return c
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join('');
  if (msg.blocks)
    return msg.blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join('');
  return '';
}

export function msgKey(m: ChatMessage): string {
  // Prefer the top-level id; fall back to the gateway's internal id at
  // `__openclaw.id`. Without the fallback, chat.history payloads that omit
  // the top-level id (most of them) collapse to a content-only key and
  // dedup gets fuzzy across messages whose content collides.
  const stableId = m.id || m.__openclaw?.id;
  if (stableId) return `id:${stableId}`;
  return `c:${m.role}|${msgText(m).slice(0, 300)}`;
}

export function isHiddenInfraMsg(m: ChatMessage): boolean {
  if (m.role !== 'user') return false;
  return msgText(m).trim() === '/new';
}

// Tool-call return values (web_fetch / sessions_send / sessions_history) come
// back through chat.history with role:"toolResult" and a giant JSON dump in
// content. They have no value to the chat reader.
export function isToolResultMsg(m: ChatMessage): boolean {
  return m.role === 'toolResult';
}

// When the agent uses sessions_send to write to its own ClawTab session, the
// gateway echoes the message back as a user-role entry tagged
// provenance.kind === "inter_session". These are internal command bounces.
export function isInterSessionEcho(m: ChatMessage): boolean {
  return m.role === 'user' && m.provenance?.kind === 'inter_session';
}

export function extractJsonBlock(text: string): Record<string, unknown> | null {
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function extractToolCalls(msg: ChatMessage): ToolCall[] {
  const blocks = Array.isArray(msg.content)
    ? (msg.content as Array<{ type: string }>)
    : Array.isArray(msg.blocks)
      ? msg.blocks
      : [];
  return blocks.filter((b): b is ToolCall => b.type === 'tool_use');
}

export function isTerminalMsg(m: ChatMessage): boolean {
  if (m.role !== 'assistant') return false;
  const text = msgText(m);
  const json = extractJsonBlock(text);
  if (json && json.type === 'clawtab_cmd') {
    const action = json.action as string;
    return ['task_done', 'task_fail', 'cancel'].includes(action);
  }
  const cleaned = text.replace(/```json[\s\S]*?```/g, '').trim();
  if (cleaned) return true;
  return extractToolCalls(m).length === 0;
}

const OP_LABELS_ZH: Record<string, string> = {
  navigate: '导航',
  click: '点击',
  fill: '填写',
  screenshot: '截图',
  scroll: '滚动',
  eval: '执行脚本',
  get_text: '读取文本',
  new_tab: '新标签页',
  close_tab: '关闭标签页',
};

const ACTION_LABELS_ZH: Record<string, string> = {
  perceive: '感知页面',
  act: '操作页面',
  task_start: '任务开始',
  task_done: '任务完成',
  task_fail: '任务失败',
  cancel: '已取消',
};

export function summariseCmd(cmd: {
  action: string;
  payload?: { op?: string };
}): { label: string; op?: string; icon: string } {
  const iconMap: Record<string, string> = {
    perceive: 'eye',
    act: 'mouse-pointer',
    task_start: 'settings',
    task_done: 'settings',
    task_fail: 'alert-triangle',
    cancel: 'power-off',
  };
  const icon = iconMap[cmd.action] ?? 'settings';
  const base = ACTION_LABELS_ZH[cmd.action] ?? cmd.action;
  const op = cmd.payload?.op ? (OP_LABELS_ZH[cmd.payload.op] ?? cmd.payload.op) : undefined;
  return { label: base, op, icon };
}

export function summariseToolCall(tc: ToolCall): { name: string; preview: string } {
  const name = String(tc.name || tc.id || 'tool');
  const input = tc.input || {};
  const skip = new Set(['code', 'content', 'text', 'html', 'script', 'query']);
  const preview = Object.entries(input)
    .filter(([k]) => !skip.has(k))
    .slice(0, 2)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`)
    .join(' · ');
  return { name, preview };
}
