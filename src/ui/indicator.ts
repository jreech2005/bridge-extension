import type { SearchResult } from '@/shared/types';

export type IndicatorState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'none' }
  | { status: 'found'; results: SearchResult[]; count: number };

export interface Indicator {
  setState(state: IndicatorState): void;
  unmount(): void;
}

const STYLES = `
  :host { all: initial; }
  .badge {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 12px;
    line-height: 1.3;
    color: #fff;
    background: #1f2937;
    border: 1px solid #374151;
    border-radius: 8px;
    padding: 6px 10px;
    pointer-events: auto;
    cursor: default;
    box-shadow: 0 2px 6px rgba(0,0,0,0.25);
    max-width: 320px;
    user-select: none;
  }
  .badge.clickable { cursor: pointer; }
  .row { display: flex; align-items: center; gap: 8px; }
  .skip {
    background: transparent;
    color: #9ca3af;
    border: none;
    font-size: 11px;
    cursor: pointer;
    padding: 0 0 0 4px;
    margin-left: 6px;
  }
  .skip:hover { color: #fff; }
  .preview {
    margin-top: 8px;
    border-top: 1px solid #374151;
    padding-top: 8px;
    max-height: 240px;
    overflow-y: auto;
  }
  .item { margin-bottom: 8px; }
  .item:last-child { margin-bottom: 0; }
  .meta { color: #9ca3af; font-size: 11px; margin-bottom: 2px; }
  .snippet { color: #e5e7eb; font-size: 11px; white-space: pre-wrap; }
  .hidden { display: none; }
`;

export function mountIndicator(
  inputElement: HTMLElement,
  onDismiss: () => void,
): Indicator {
  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.zIndex = '2147483647';
  host.style.pointerEvents = 'none';
  document.body.appendChild(host);

  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLES;
  root.appendChild(style);

  const badge = document.createElement('div');
  badge.className = 'badge';

  const row = document.createElement('div');
  row.className = 'row';
  const label = document.createElement('span');
  row.appendChild(label);
  const skip = document.createElement('button');
  skip.className = 'skip';
  skip.textContent = 'skip';
  skip.addEventListener('click', (e) => {
    e.stopPropagation();
    onDismiss();
  });
  row.appendChild(skip);
  badge.appendChild(row);

  const preview = document.createElement('div');
  preview.className = 'preview hidden';
  badge.appendChild(preview);

  let expanded = false;
  let currentResults: SearchResult[] = [];
  badge.addEventListener('click', () => {
    if (currentResults.length === 0) return;
    expanded = !expanded;
    preview.classList.toggle('hidden', !expanded);
  });

  root.appendChild(badge);

  const reposition = () => {
    const rect = inputElement.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      host.style.display = 'none';
      return;
    }
    host.style.display = '';
    host.style.left = `${rect.left}px`;
    host.style.top = `${Math.max(8, rect.top - 36)}px`;
  };
  reposition();
  const repoListener = () => reposition();
  window.addEventListener('scroll', repoListener, true);
  window.addEventListener('resize', repoListener);
  const ro = new ResizeObserver(reposition);
  try {
    ro.observe(inputElement);
  } catch {
    // ignore
  }

  function renderPreview(results: SearchResult[]): void {
    preview.replaceChildren();
    for (const r of results) {
      const item = document.createElement('div');
      item.className = 'item';
      const meta = document.createElement('div');
      meta.className = 'meta';
      const title = r.conversation.title ?? '(untitled)';
      meta.textContent = `${title} · ${r.conversation.platform} · ${r.score.toFixed(2)}`;
      const snippet = document.createElement('div');
      snippet.className = 'snippet';
      const text = r.chunk.combinedText.slice(0, 200).trim();
      snippet.textContent = text + (r.chunk.combinedText.length > 200 ? '…' : '');
      item.appendChild(meta);
      item.appendChild(snippet);
      preview.appendChild(item);
    }
  }

  function setState(state: IndicatorState): void {
    expanded = false;
    preview.classList.add('hidden');
    badge.classList.remove('clickable');
    skip.classList.remove('hidden');
    switch (state.status) {
      case 'idle':
        host.style.display = 'none';
        return;
      case 'searching':
        host.style.display = '';
        label.textContent = '🔎 Searching past chats…';
        currentResults = [];
        break;
      case 'none':
        host.style.display = '';
        label.textContent = 'No matching past chats';
        currentResults = [];
        break;
      case 'found':
        host.style.display = '';
        label.textContent = `📚 ${state.count} past chat${state.count === 1 ? '' : 's'} found — click to preview`;
        currentResults = state.results;
        renderPreview(state.results);
        badge.classList.add('clickable');
        break;
    }
    reposition();
  }

  function unmount(): void {
    window.removeEventListener('scroll', repoListener, true);
    window.removeEventListener('resize', repoListener);
    try {
      ro.disconnect();
    } catch {
      // ignore
    }
    host.remove();
  }

  return { setState, unmount };
}
