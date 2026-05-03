import { Download, Power } from 'lucide-react';
import { useState } from 'react';
import { IconButton } from './IconButton';
import { LangBadge } from './LangBadge';
import { Tooltip } from './Tooltip';
import { t, type Lang } from '../i18n';
import { bg, clog } from '../lib/messages';
import type { ChatMessage } from '@/shared/types/protocol';

function chatHistoryToJsonl(
  meta: { sessionKey: string; agent: string; browserId: string; exportedAt: string },
  messages: ChatMessage[],
): string {
  const lines: string[] = [];
  lines.push(JSON.stringify({ kind: 'session_meta', ...meta }));
  for (const m of messages) {
    lines.push(JSON.stringify({ kind: 'message', ...m }));
  }
  return lines.join('\n') + '\n';
}

export function ChatHeader({
  lang,
  agent,
  agents,
  onSwitchAgent,
  connected,
  reconnecting,
  onToggleLang,
  onToast,
  channelName,
}: {
  lang: Lang;
  agent: string;
  agents: string[];
  onSwitchAgent: (a: string) => void;
  connected: boolean;
  reconnecting: boolean;
  onToggleLang: () => void;
  onToast: (text: string, error?: boolean) => void;
  channelName: string;
}) {
  const [exporting, setExporting] = useState(false);

  const statusText = connected
    ? t(lang, 'connected')
    : reconnecting
      ? t(lang, 'reconnecting')
      : t(lang, 'disconnected');

  const doExportSession = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const sessionKey = `agent:${agent}:clawtab-${channelName}`;
      const res = await bg.fetchHistory(sessionKey);
      if (!res.ok) {
        onToast(t(lang, 'exportFailed'), true);
        return;
      }
      const exportedAt = new Date().toISOString();
      const text = chatHistoryToJsonl(
        { sessionKey, agent, browserId: channelName, exportedAt },
        res.messages || [],
      );
      const stamp = exportedAt.replace(/[:.]/g, '-').slice(0, 19);
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(
          new Blob([text], { type: 'application/x-ndjson;charset=utf-8' }),
        ),
        download: `clawtab-session-${stamp}.jsonl`,
      });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) {
      clog('error', 'export session failed', { error: (e as Error).message });
      onToast(t(lang, 'exportFailed'), true);
    } finally {
      setExporting(false);
    }
  };

  return (
    <header className="flex h-[44px] shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-2">
      <Tooltip label="Agent">
        <select
          value={agent}
          onChange={(e) => onSwitchAgent(e.target.value)}
          className="h-7 rounded-md border border-slate-200 bg-white px-2 text-[12px] font-medium text-slate-700 focus:border-brand-ring focus:outline-none"
        >
          {agents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </Tooltip>
      <div className="flex flex-1 items-center gap-1.5">
        <span
          className={
            'inline-block h-2 w-2 rounded-full ' +
            (connected
              ? 'bg-green-500'
              : reconnecting
                ? 'bg-amber-500 animate-pulse'
                : 'bg-slate-300')
          }
        />
        <span className="text-[11.5px] text-slate-500">{statusText}</span>
      </div>
      <IconButton
        tooltip={t(lang, 'exportSession')}
        variant="ghost"
        size="sm"
        disabled={!connected || exporting}
        onClick={doExportSession}
      >
        <Download size={14} />
      </IconButton>
      <IconButton
        tooltip={t(lang, 'langSwitchTo')}
        variant="ghost"
        size="sm"
        onClick={onToggleLang}
      >
        <LangBadge currentLang={lang} />
      </IconButton>
      <IconButton
        tooltip={t(lang, 'disconnect')}
        variant="ghost"
        size="sm"
        onClick={() => bg.disconnect().catch(() => {})}
      >
        <Power size={14} />
      </IconButton>
    </header>
  );
}
