import type { SearchResult } from '@/shared/types';

const STYLES = `
  :host { all: initial; }
  .badge {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 11px;
    color: #d1d5db;
    background: rgba(31, 41, 55, 0.85);
    border: 1px solid #374151;
    border-radius: 6px;
    padding: 4px 8px;
    margin: 4px 0;
    cursor: pointer;
    display: inline-block;
    user-select: none;
  }
  .badge:hover { background: rgba(31, 41, 55, 1); }
  .full {
    margin-top: 6px;
    padding: 8px;
    background: #111827;
    border: 1px solid #374151;
    border-radius: 6px;
    color: #e5e7eb;
    white-space: pre-wrap;
    font-size: 11px;
    line-height: 1.4;
    max-height: 320px;
    overflow-y: auto;
  }
  .hidden { display: none; }
  .meta { color: #9ca3af; font-size: 10px; margin-bottom: 4px; }
`;

function buildFullText(results: SearchResult[]): string {
  return results
    .map((r) => {
      const date = new Date(r.conversation.capturedAt).toISOString().slice(0, 10);
      const title = r.conversation.title ?? '(untitled)';
      return `From "${title}" (${r.conversation.platform}, ${date}, score ${r.score.toFixed(2)}):\n${r.chunk.combinedText}`;
    })
    .join('\n\n---\n\n');
}

export function appendInjectionBadge(
  messageElement: HTMLElement,
  results: SearchResult[],
): void {
  if (results.length === 0) return;
  const parent = messageElement.parentElement;
  if (!parent) return;

  const host = document.createElement('div');
  host.style.display = 'block';
  parent.insertBefore(host, messageElement);

  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLES;
  root.appendChild(style);

  const badge = document.createElement('div');
  badge.className = 'badge';
  badge.textContent = `📚 ${results.length} past chat${results.length === 1 ? '' : 's'} injected — click to view`;
  root.appendChild(badge);

  const full = document.createElement('div');
  full.className = 'full hidden';
  full.textContent = buildFullText(results);
  root.appendChild(full);

  badge.addEventListener('click', () => {
    full.classList.toggle('hidden');
  });
}
