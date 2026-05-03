// Markdown renderer wrapper. Sanitizes and rewrites <a> for sidepanel safety.
// Clicks are intercepted by a delegated listener in App.tsx (not here).

import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

function sanitizeHtml(html: string): string {
  return (
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/<iframe\b[\s\S]*?>/gi, '')
      .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
      .replace(/href\s*=\s*["']?\s*javascript:[^"'\s>]*/gi, 'href="#"')
      // Every <a> forced to new-tab as defense-in-depth; the click delegate on
      // the chat container calls chrome.tabs.create so target="_blank" by
      // itself doesn't have to do the heavy lifting.
      .replace(/<a\b([^>]*)>/gi, (_, attrs: string) => {
        const stripped = attrs
          .replace(/\s+target\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '')
          .replace(/\s+rel\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '');
        return `<a${stripped} target="_blank" rel="noopener noreferrer">`;
      })
  );
}

export function renderMarkdown(raw: string): string {
  if (!raw) return '';
  try {
    return sanitizeHtml(String(marked.parse(String(raw), { async: false })));
  } catch {
    return raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  }
}
