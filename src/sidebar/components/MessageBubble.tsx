import {
  AlertTriangle,
  Eye as EyeIcon,
  MousePointer2,
  Power,
  Settings,
} from 'lucide-react';
import type { ChatMessage } from '@/shared/types/protocol';
import {
  extractJsonBlock,
  extractToolCalls,
  msgText,
  summariseCmd,
  summariseToolCall,
} from '../lib/message-utils';
import { renderMarkdown } from '../lib/markdown';
import type { Attachment } from '../state/reducer';
import { bg } from '../lib/messages';
import type { Lang } from '../i18n';
import { t } from '../i18n';

const TOOL_ICONS = {
  eye: EyeIcon,
  'mouse-pointer': MousePointer2,
  settings: Settings,
  'alert-triangle': AlertTriangle,
  'power-off': Power,
} as const;

function ToolIconRow({
  icon,
  label,
  detail,
}: {
  icon: keyof typeof TOOL_ICONS;
  label: string;
  detail?: string;
}) {
  const Icon = TOOL_ICONS[icon] ?? Settings;
  return (
    <div className="my-1 inline-flex items-center gap-1.5 rounded-md bg-slate-50 px-2 py-1 text-[11px] text-slate-600">
      <Icon size={13} className="shrink-0" />
      <span>{label}</span>
      {detail ? <span className="text-slate-400">· {detail}</span> : null}
    </div>
  );
}

function AttachmentChip({
  attachment,
  index,
  interactive,
  onDelete,
}: {
  attachment: Attachment;
  index: number;
  interactive: boolean;
  onDelete?: () => void;
}) {
  const label = `#${index + 1}:${attachment.tag}`;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600 transition hover:bg-slate-200"
      title={`${attachment.tag}${attachment.id ? '#' + attachment.id : ''}${attachment.text ? '\n"' + attachment.text + '"' : ''}\n${attachment.selector}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        bg.flashElement(attachment.selector).catch(() => {});
      }}
    >
      <span>{label}</span>
      {interactive && onDelete ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="flex h-4 w-4 items-center justify-center rounded-full text-slate-400 hover:bg-slate-300 hover:text-slate-700"
          aria-label="Remove attachment"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

export function MessageBubble({ msg }: { msg: ChatMessage }) {
  const text = msgText(msg);
  const toolCalls = extractToolCalls(msg);
  const json = extractJsonBlock(text);

  if (json && json.type === 'clawtab_cmd') {
    const s = summariseCmd({
      action: String(json.action),
      payload: json.payload as { op?: string } | undefined,
    });
    return (
      <ToolIconRow
        icon={s.icon as keyof typeof TOOL_ICONS}
        label={s.label}
        detail={s.op}
      />
    );
  }

  if (!text.trim() && toolCalls.length) {
    return (
      <>
        {toolCalls.map((tc, i) => {
          const s = summariseToolCall(tc);
          return <ToolIconRow key={i} icon="settings" label={s.name} detail={s.preview} />;
        })}
      </>
    );
  }

  const cleaned = text.replace(/```json[\s\S]*?```/g, '').trim();
  if (!cleaned && !toolCalls.length) return null;

  const role = msg.role === 'user' ? 'user' : 'assistant';
  const attachments = ((msg as ChatMessage & { attachments?: unknown[] }).attachments ??
    []) as Attachment[];

  return (
    <div
      className={
        'flex w-full min-w-0 ' +
        (role === 'user'
          ? 'flex-col items-end self-end'
          : 'flex-col items-start self-stretch')
      }
      data-local-echo={msg.id?.startsWith('local-') ? '1' : undefined}
    >
      {cleaned ? (
        role === 'user' ? (
          <div className="max-w-[calc(100%-120px)] min-w-0 rounded-2xl bg-brand px-3 py-2 text-[12.5px] text-white">
            <div
              className="md-bubble md-bubble-user"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(cleaned) }}
            />
          </div>
        ) : (
          <div className="w-full min-w-0 px-1 py-1 text-[12.5px] text-slate-900">
            <div
              className="md-bubble"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(cleaned) }}
            />
          </div>
        )
      ) : null}
      {toolCalls.map((tc, i) => {
        const s = summariseToolCall(tc);
        return <ToolIconRow key={i} icon="settings" label={s.name} detail={s.preview} />;
      })}
      {role === 'user' && attachments.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {attachments.map((a, i) => (
            <AttachmentChip
              key={i}
              attachment={a}
              index={i}
              interactive={false}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export { AttachmentChip, ToolIconRow };

/** Exported for unit tests in phase 5 (the render path needs a stable label). */
export function __renderMarkdown(raw: string): string {
  return renderMarkdown(raw);
}

export { msgText, extractJsonBlock, extractToolCalls } from '../lib/message-utils';
export { t as __i18nT };
export type { Lang as __Lang };
