import type { LoopSnapshot, LoopStatus } from '@/shared/types/state';
import { t, type Lang } from '../i18n';
import { bg } from '../lib/messages';

const LOOP_LABELS: Record<LoopStatus, string> = {
  idle: 'loopIdle',
  perceiving: 'loopPerceiving',
  thinking: 'loopThinking',
  acting: 'loopActing',
  done: 'loopDone',
  failed: 'loopFailed',
  cancelled: 'loopCancelled',
};

export function TaskBar({
  lang,
  loop,
  onThumbClick,
}: {
  lang: Lang;
  loop: LoopSnapshot | null;
  onThumbClick: (src: string) => void;
}) {
  if (!loop || loop.status === 'idle') return null;
  const statusText =
    loop.statusText ||
    t(lang, LOOP_LABELS[loop.status] as Parameters<typeof t>[1]);
  return (
    <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium text-slate-900">
          {loop.goal || '—'}
        </div>
        <div className="truncate text-[11px] text-slate-500">{statusText}</div>
      </div>
      {loop.lastScreenshot ? (
        <button
          type="button"
          title={t(lang, 'openFullScreenshot')}
          aria-label={t(lang, 'openFullScreenshot')}
          onClick={() => loop.lastScreenshot && onThumbClick(loop.lastScreenshot)}
          className="h-10 w-10 overflow-hidden rounded-md border border-slate-200 bg-slate-100 transition hover:border-brand-ring"
        >
          <img src={loop.lastScreenshot} alt="screenshot" className="h-full w-full object-cover" />
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => bg.cancel().catch(() => {})}
        className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 transition hover:bg-slate-50"
      >
        {t(lang, 'taskCancel')}
      </button>
    </div>
  );
}
