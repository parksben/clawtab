// Agent protocol types for `clawtab_cmd` / `clawtab_result` JSON blocks.
// These live in assistant chat messages and drive the browser automation
// loop. See AGENT_PROTOCOL.md for the user-facing spec.

export type ClawtabCmdAction =
  | 'perceive'
  | 'act'
  | 'task_start'
  | 'task_done'
  | 'task_fail'
  | 'cancel'
  | 'capabilities';

export type PerceiveInclude =
  | 'screenshot'
  | 'title'
  | 'url'
  | 'dom'
  | 'scroll_position'
  | 'all';

export interface PerceivePayload {
  tabId?: number;
  include?: PerceiveInclude[];
}

export type ActOp =
  | 'click'
  | 'fill'
  | 'fill_form'
  | 'clear'
  | 'navigate'
  | 'scroll'
  | 'scroll_by'
  | 'scroll_to_element'
  | 'press'
  | 'select'
  | 'hover'
  | 'wait'
  | 'wait_for'
  | 'wait_for_url'
  | 'get_text'
  | 'get_attribute'
  | 'get_all_links'
  | 'get_article_text'
  | 'new_tab'
  | 'close_tab'
  | 'switch_tab'
  | 'list_tabs'
  | 'go_back'
  | 'go_forward'
  | 'screenshot_element'
  | 'eval';

export interface ActPayload {
  tabId?: number;
  op: ActOp;
  target?: string | number;
  value?: string | number;
  /**
   * Batch field map for `op: "fill_form"`. Map from selector to value.
   * Example: `{ "#username": "alice", "input[name=pw]": "secret" }`.
   */
  fields?: Record<string, string>;
  /**
   * When true, the DOM query function pierces open shadow roots when
   * resolving selectors. Defaults to false (host document only). Applies to
   * `click`, `fill`, `clear`, `get_text`, `hover`, `scroll_to_element`.
   */
  pierceShadow?: boolean;
  waitAfter?: number;
  captureAfter?: boolean;
  timeout?: number;
}

export interface TaskStartPayload {
  taskId?: string;
  goal?: string;
  agentId?: string;
  tabId?: number;
}

export interface TaskDonePayload {
  summary?: string;
}

export interface TaskFailPayload {
  error?: string;
}

export type ClawtabCmd =
  | {
      type: 'clawtab_cmd';
      cmdId: string;
      agentId?: string;
      action: 'perceive';
      payload?: PerceivePayload;
      issuedAt?: number;
      timeout?: number;
    }
  | {
      type: 'clawtab_cmd';
      cmdId: string;
      agentId?: string;
      action: 'act';
      payload?: ActPayload;
      issuedAt?: number;
      timeout?: number;
    }
  | {
      type: 'clawtab_cmd';
      cmdId: string;
      agentId?: string;
      action: 'task_start';
      payload?: TaskStartPayload;
      issuedAt?: number;
      timeout?: number;
    }
  | {
      type: 'clawtab_cmd';
      cmdId: string;
      agentId?: string;
      action: 'task_done';
      payload?: TaskDonePayload;
      issuedAt?: number;
      timeout?: number;
    }
  | {
      type: 'clawtab_cmd';
      cmdId: string;
      agentId?: string;
      action: 'task_fail';
      payload?: TaskFailPayload;
      issuedAt?: number;
      timeout?: number;
    }
  | {
      type: 'clawtab_cmd';
      cmdId: string;
      agentId?: string;
      action: 'cancel';
      payload?: Record<string, unknown>;
      issuedAt?: number;
      timeout?: number;
    }
  | {
      type: 'clawtab_cmd';
      cmdId: string;
      agentId?: string;
      action: 'capabilities';
      payload?: Record<string, unknown>;
      issuedAt?: number;
      timeout?: number;
    };

export type ClawtabErrorCode =
  | 'BUSY'
  | 'EXPIRED'
  | 'PERCEIVE_FAILED'
  | 'ACT_FAILED'
  | 'UNKNOWN_ACTION'
  | 'DISCONNECTED';

export interface ClawtabResult {
  type: 'clawtab_result';
  cmdId: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
  errorCode?: ClawtabErrorCode;
  op?: ActOp;
  busyStatus?: string;
  browserId: string;
  ts: number;
}

// Chat message as returned by the Gateway's chat.history endpoint. Uses loose
// typing because server shape varies slightly (blocks / content / id).
//
// `role` includes "toolResult" — those are tool-call return values (web_fetch,
// sessions_send, sessions_history dumps) that the sidebar filters out.
//
// `provenance.kind === "inter_session"` marks user messages that were echoed
// back from another session via the agent's `sessions_send` tool. These are
// internal command bounces and must not render in the chat list.
//
// `__openclaw.id` is the gateway's internal stable id. Some chat.history
// payloads omit the top-level `id` and only carry it inside `__openclaw`, so
// any code that needs a stable identifier (msgKey / lastSeenMsgId tracking)
// must fall back to `m.__openclaw?.id` when `m.id` is missing.
export interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system' | 'toolResult' | string;
  content?: string | Array<{ type: string; text?: string }>;
  blocks?: Array<{ type: string; text?: string }>;
  timestamp?: number;
  ts?: number;
  createdAt?: number;
  attachments?: unknown[];
  provenance?: {
    kind?: string;
    sourceSessionKey?: string;
    sourceChannel?: string;
    sourceTool?: string;
  };
  __openclaw?: {
    id?: string;
    seq?: number;
  };
}
