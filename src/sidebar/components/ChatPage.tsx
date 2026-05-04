import { useEffect, useState } from 'react';
import type { ChatMessage } from '@/shared/types/protocol';
import type { LoopSnapshot } from '@/shared/types/state';
import type { Attachment } from '../state/reducer';
import { ChatHeader } from './ChatHeader';
import { TaskBar } from './TaskBar';
import { MessageList } from './MessageList';
import { InputArea } from './InputArea';
import { DevPanel } from './DevPanel';
import { useDevToolsEnabled } from '../hooks/useDevToolsEnabled';
import type { Lang } from '../i18n';

export function ChatPage({
  lang,
  onToggleLang,
  agent,
  agents,
  onSwitchAgent,
  connected,
  reconnecting,
  loop,
  messages,
  waiting,
  sending,
  chatError,
  pickMode,
  attachments,
  onTogglePickMode,
  onClearContext,
  onSend,
  onRemoveAttachment,
  onToast,
  channelName,
}: {
  lang: Lang;
  onToggleLang: () => void;
  agent: string;
  agents: string[];
  onSwitchAgent: (a: string) => void;
  connected: boolean;
  reconnecting: boolean;
  loop: LoopSnapshot | null;
  messages: ChatMessage[];
  waiting: boolean;
  sending: boolean;
  chatError: string | null;
  pickMode: boolean;
  attachments: Attachment[];
  onTogglePickMode: () => void;
  onClearContext: () => void;
  onSend: (text: string, sentAttachments: Attachment[]) => void;
  onRemoveAttachment: (index: number) => void;
  onToast: (text: string, error?: boolean) => void;
  channelName: string;
}) {
  const [lightbox, setLightbox] = useState<string | null>(null);
  const devToolsEnabled = useDevToolsEnabled();

  // ESC closes the lightbox
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  return (
    <div className="flex h-full flex-col bg-white">
      <ChatHeader
        lang={lang}
        agent={agent}
        agents={agents}
        onSwitchAgent={onSwitchAgent}
        connected={connected}
        reconnecting={reconnecting}
        onToggleLang={onToggleLang}
        onToast={onToast}
        channelName={channelName}
      />
      <TaskBar lang={lang} loop={loop} onThumbClick={setLightbox} />
      {devToolsEnabled ? <DevPanel connected={connected} /> : null}
      <div className="flex-1 overflow-hidden">
        <MessageList
          lang={lang}
          connected={connected}
          agent={agent}
          messages={messages}
          waiting={waiting}
          chatError={chatError}
        />
      </div>
      <InputArea
        lang={lang}
        wsConnected={connected}
        reconnecting={reconnecting}
        waiting={waiting}
        sending={sending}
        pickMode={pickMode}
        attachments={attachments}
        onTogglePickMode={onTogglePickMode}
        onClearContext={onClearContext}
        onSend={(text) => onSend(text, attachments)}
        onRemoveAttachment={onRemoveAttachment}
      />

      {lightbox ? (
        <div
          role="presentation"
          onClick={() => setLightbox(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          <img src={lightbox} alt="screenshot full" className="max-h-full max-w-full" />
        </div>
      ) : null}
    </div>
  );
}
