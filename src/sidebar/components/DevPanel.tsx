import { useState } from 'react';
import { ChevronDown, ChevronRight, FlaskConical, Play } from 'lucide-react';
import { bg } from '../lib/messages';

type Outcome = {
  label: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  durationMs: number;
} | null;

interface TestSpec {
  label: string;
  group: string;
  run: () => Promise<{ ok: boolean; data?: unknown; error?: string }>;
}

const TESTS: TestSpec[] = [
  // capabilities
  {
    label: 'capabilities',
    group: 'meta',
    run: () => bg.devCapabilities(),
  },
  // perceive
  {
    label: 'perceive (title + url)',
    group: 'perceive',
    run: () => bg.devRunPerceive(['title', 'url']),
  },
  {
    label: 'perceive (dom)',
    group: 'perceive',
    run: () => bg.devRunPerceive(['dom']),
  },
  {
    label: 'perceive (screenshot)',
    group: 'perceive',
    run: () => bg.devRunPerceive(['screenshot']),
  },
  // tabs
  {
    label: 'list_tabs',
    group: 'tabs',
    run: () => bg.devRunAct({ op: 'list_tabs', captureAfter: false }),
  },
  // content extraction
  {
    label: 'get_all_links',
    group: 'content',
    run: () => bg.devRunAct({ op: 'get_all_links', captureAfter: false }),
  },
  {
    label: 'get_article_text',
    group: 'content',
    run: () => bg.devRunAct({ op: 'get_article_text', captureAfter: false }),
  },
  {
    label: 'get_text(title)',
    group: 'content',
    run: () =>
      bg.devRunAct({ op: 'get_text', target: 'title', captureAfter: false }),
  },
  // navigation
  {
    label: 'scroll_by(0, 400)',
    group: 'navigation',
    run: () =>
      bg.devRunAct({ op: 'scroll_by', target: 0, value: 400, captureAfter: false }),
  },
  {
    label: 'go_back',
    group: 'navigation',
    run: () => bg.devRunAct({ op: 'go_back', captureAfter: false }),
  },
  // input
  {
    label: 'press(ctrl+a)',
    group: 'input',
    run: () =>
      bg.devRunAct({ op: 'press', value: 'ctrl+a', captureAfter: false }),
  },
  {
    label: 'press(Escape)',
    group: 'input',
    run: () =>
      bg.devRunAct({ op: 'press', value: 'Escape', captureAfter: false }),
  },
  // eval
  {
    label: "eval(document.title)",
    group: 'eval',
    run: () =>
      bg.devRunAct({
        op: 'eval',
        value: 'document.title',
        captureAfter: false,
      }),
  },
];

const GROUPS = ['meta', 'perceive', 'tabs', 'content', 'navigation', 'input', 'eval'];

function summarize(data: unknown): string {
  if (data == null) return 'null';
  try {
    const text = JSON.stringify(data, (_k, v) => {
      if (typeof v === 'string' && v.startsWith('data:image/')) {
        return `<data-uri ${v.length} chars>`;
      }
      if (typeof v === 'string' && v.length > 500) {
        return v.slice(0, 500) + `…(+${v.length - 500})`;
      }
      return v;
    }, 2);
    return text.length > 3500 ? text.slice(0, 3500) + '\n…(truncated)' : text;
  } catch {
    return String(data);
  }
}

function extractScreenshot(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.screenshot === 'string' && d.screenshot.startsWith('data:image/')) {
    return d.screenshot;
  }
  return null;
}

export function DevPanel({ connected }: { connected: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [runningLabel, setRunningLabel] = useState<string | null>(null);

  async function run(spec: TestSpec) {
    if (runningLabel) return;
    setRunningLabel(spec.label);
    const t0 = performance.now();
    try {
      const res = await spec.run();
      setOutcome({
        label: spec.label,
        ok: !!res.ok,
        data: res.data,
        error: res.error,
        durationMs: Math.round(performance.now() - t0),
      });
    } catch (e) {
      setOutcome({
        label: spec.label,
        ok: false,
        error: (e as Error).message,
        durationMs: Math.round(performance.now() - t0),
      });
    } finally {
      setRunningLabel(null);
    }
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="flex items-center gap-1.5 border-y border-amber-200 bg-amber-50 px-3 py-1 text-[11px] font-medium text-amber-800"
      >
        <ChevronRight size={13} />
        <FlaskConical size={13} />
        <span>Dev tools</span>
        <span className="text-amber-600">(development-only)</span>
      </button>
    );
  }

  const shot = outcome ? extractScreenshot(outcome.data) : null;

  return (
    <div className="border-y border-amber-200 bg-amber-50/60 text-[11px] text-slate-700">
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="flex w-full items-center gap-1.5 px-3 py-1 font-medium text-amber-800"
      >
        <ChevronDown size={13} />
        <FlaskConical size={13} />
        <span>Dev tools</span>
        <span className="ml-auto text-amber-600">click to collapse</span>
      </button>
      <div className="flex flex-col gap-2 px-3 py-2">
        {GROUPS.map((g) => {
          const tests = TESTS.filter((t) => t.group === g);
          if (!tests.length) return null;
          return (
            <div key={g} className="flex flex-wrap items-center gap-1">
              <span className="w-20 shrink-0 text-[10px] uppercase tracking-wider text-slate-500">
                {g}
              </span>
              {tests.map((t) => (
                <button
                  key={t.label}
                  type="button"
                  disabled={!connected || runningLabel !== null}
                  onClick={() => run(t)}
                  className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-[10.5px] text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                >
                  {runningLabel === t.label ? (
                    <span className="inline-block h-2 w-2 animate-spin rounded-full border border-slate-400 border-t-transparent" />
                  ) : (
                    <Play size={10} />
                  )}
                  {t.label}
                </button>
              ))}
            </div>
          );
        })}
        {!connected ? (
          <div className="text-[10px] text-slate-500">
            Not connected — buttons disabled.
          </div>
        ) : null}
        {outcome ? (
          <div
            className={
              'mt-1 rounded border px-2 py-1.5 ' +
              (outcome.ok
                ? 'border-emerald-200 bg-emerald-50'
                : 'border-red-200 bg-red-50')
            }
          >
            <div className="mb-1 flex items-center gap-2 text-[10px]">
              <span className={outcome.ok ? 'text-emerald-700' : 'text-red-700'}>
                {outcome.ok ? '✓' : '✗'} {outcome.label}
              </span>
              <span className="text-slate-500">{outcome.durationMs}ms</span>
            </div>
            {shot ? (
              <img
                src={shot}
                alt="result screenshot"
                className="mb-1 max-h-32 rounded border border-slate-200"
              />
            ) : null}
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-[10.5px] leading-snug text-slate-700">
              {outcome.error ?? summarize(outcome.data)}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}
