import { ClaudeAdapter } from '@/adapters/claude';
import { chunkTurn } from '@/shared/chunker';
import {
  db,
  deleteChunksFromTurn,
  upsertChunk,
  upsertConversation,
} from '@/storage/db';
import { embedInContentScript } from '@/embeddings/embedder-cs';
import { startBackfill } from '@/embeddings/backfill';
import { detectBoundaryTrigger } from '@/triggers/boundary';
import { searchChunks } from '@/retrieval/search';
import { mountIndicator, type Indicator } from '@/ui/indicator';
import { appendInjectionBadge } from '@/ui/badge';
import type {
  ClaudeProject,
  SearchResult,
  TriggerMatch,
  TriggerSource,
} from '@/shared/types';

const PROJECTS_STORAGE_KEY = 'bridge:claude:projects';
const INPUT_SELECTOR = '[data-testid="chat-input"]';
const SEND_BUTTON_SELECTOR = 'button[aria-label*="Send" i]';
const USER_MESSAGE_SELECTORS = '[data-testid="user-message"], [data-user-message-bubble="true"]';
const INPUT_DEBOUNCE_MS = 300;
const EXCERPT_MAX_CHARS = 500;
const BADGE_WAIT_MS = 5000;

const adapter = new ClaudeAdapter();

adapter.onTurn(async (turn, edit) => {
  const conversationKey = `claude:${turn.conversationId}`;
  try {
    if (edit) {
      await deleteChunksFromTurn(conversationKey, edit.fromTurnIndex);
    }
    await upsertConversation({
      id: conversationKey,
      platform: 'claude',
      platformConversationId: turn.conversationId,
      project: turn.project,
      title: turn.conversationTitle,
      url: turn.url,
      capturedAt: turn.capturedAt,
    });
    const chunks = chunkTurn({ ...turn, conversationId: conversationKey });
    for (const chunk of chunks) {
      await upsertChunk(chunk);
      void embedInContentScript(chunk.combinedText)
        .then(async (vector) => {
          await db.chunks.update(chunk.id, { vector });
          console.log('[bridge] embedded chunk', chunk.id);
        })
        .catch((err) => {
          console.warn('[bridge] live embed failed for', chunk.id, err);
        });
    }
    console.log(
      '[bridge] captured turn',
      turn.turnIndex,
      'of',
      turn.conversationId,
      edit ? `(edit from ${edit.fromTurnIndex})` : '',
      `→ ${chunks.length} chunk(s)`,
    );
  } catch (err) {
    console.warn('[bridge] capture failed', err);
  }
});

adapter.start();
startBackfill();

// ---------------- Trigger / retrieval / injection ----------------

let knownProjects: string[] = [];

function loadProjectsInto(list: ClaudeProject[] | undefined): void {
  knownProjects = (list ?? []).map((p) => p.name).filter((n): n is string => !!n);
}

void chrome.storage.local
  .get(PROJECTS_STORAGE_KEY)
  .then((got) => loadProjectsInto(got?.[PROJECTS_STORAGE_KEY] as ClaudeProject[] | undefined));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const change = changes[PROJECTS_STORAGE_KEY];
  if (change) loadProjectsInto(change.newValue as ClaudeProject[] | undefined);
});

let activeIndicator: Indicator | null = null;
let activeMatch: TriggerMatch | null = null;
let activeResults: SearchResult[] = [];
let searchSeq = 0;
let injecting = false;
let inputTimer: ReturnType<typeof setTimeout> | null = null;

function findInput(): HTMLElement | null {
  return document.querySelector<HTMLElement>(INPUT_SELECTOR);
}

function findSendButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(SEND_BUTTON_SELECTOR);
}

function clearTrigger(): void {
  activeMatch = null;
  activeResults = [];
  if (activeIndicator) {
    activeIndicator.unmount();
    activeIndicator = null;
  }
}

function ensureIndicator(input: HTMLElement): Indicator {
  if (!activeIndicator) {
    activeIndicator = mountIndicator(input, () => clearTrigger());
  }
  return activeIndicator;
}

function sameSource(a: TriggerSource | null | undefined, b: TriggerSource): boolean {
  if (!a) return false;
  if (a.type !== b.type) return false;
  if (a.type === 'platform' && b.type === 'platform') return a.platform === b.platform;
  if (a.type === 'project' && b.type === 'project') return a.project === b.project;
  return false;
}

async function onInputDebounced(input: HTMLElement): Promise<void> {
  const text = (input.innerText ?? '').trim();
  console.log(
    `[bridge debug] input changed: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`,
  );
  if (!text) {
    clearTrigger();
    return;
  }
  const currentProject = adapter.getPageState().project;
  const match = detectBoundaryTrigger(text, currentProject, knownProjects);
  if (!match) {
    clearTrigger();
    return;
  }
  if (sameSource(activeMatch?.source ?? null, match.source) && activeResults.length > 0) {
    return; // Already showing results for this source — don't re-search every keystroke.
  }
  activeMatch = match;
  const indicator = ensureIndicator(input);
  indicator.setState({ status: 'searching' });
  console.log('[bridge debug] indicator render: searching');

  const seq = ++searchSeq;
  try {
    const results = await searchChunks(text, match.source);
    if (seq !== searchSeq) return; // a newer search superseded us
    activeResults = results;
    if (results.length === 0) {
      indicator.setState({ status: 'none' });
      console.log('[bridge debug] indicator render: 0 chats');
    } else {
      indicator.setState({ status: 'found', results, count: results.length });
      console.log(`[bridge debug] indicator render: ${results.length} chats`);
    }
  } catch (err) {
    console.warn('[bridge] search failed', err);
    if (seq === searchSeq) indicator.setState({ status: 'none' });
  }
}

document.addEventListener('input', (e) => {
  const target = e.target as HTMLElement | null;
  if (!target?.matches?.(INPUT_SELECTOR)) return;
  if (inputTimer) clearTimeout(inputTimer);
  inputTimer = setTimeout(() => void onInputDebounced(target), INPUT_DEBOUNCE_MS);
});
console.log(`[bridge debug] input listener attached to ${INPUT_SELECTOR}`);

function excerpt(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1).trimEnd() + '…';
}

function sourceLabel(source: TriggerSource): string {
  if (source.type === 'platform') {
    const name = source.platform === 'chatgpt' ? 'ChatGPT' : source.platform;
    return `your past ${name} conversations`;
  }
  return `your "${source.project}" project conversations`;
}

function formatInjection(results: SearchResult[], source: TriggerSource): string {
  const lines: string[] = [`[Context from ${sourceLabel(source)}:`];
  results.forEach((r, i) => {
    const date = new Date(r.conversation.capturedAt).toISOString().slice(0, 10);
    const title = r.conversation.title ?? '(untitled)';
    lines.push('');
    lines.push(`From "${title}" (${r.conversation.platform}, ${date}):`);
    lines.push(excerpt(r.chunk.userText, EXCERPT_MAX_CHARS));
    lines.push('');
    lines.push(excerpt(r.chunk.assistantText, EXCERPT_MAX_CHARS));
    if (i < results.length - 1) {
      lines.push('');
      lines.push('---');
    }
  });
  lines.push(']');
  return lines.join('\n');
}

function replaceInputContent(input: HTMLElement, text: string): void {
  input.focus();
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(input);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  // execCommand is deprecated but is still the only reliable way to drive
  // ProseMirror/Lexical editors via synthesized input events.
  document.execCommand('insertText', false, text);
}

async function waitForNewUserMessage(
  baseline: number,
  timeoutMs: number,
): Promise<HTMLElement | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const msgs = document.querySelectorAll<HTMLElement>(USER_MESSAGE_SELECTORS);
    if (msgs.length > baseline) return msgs[msgs.length - 1] ?? null;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function performInjectAndSubmit(input: HTMLElement): Promise<void> {
  const match = activeMatch;
  const results = activeResults.slice();
  if (!match || results.length === 0) return;
  const userText = (input.innerText ?? '').trim();
  if (!userText) return;

  // Clear UI state first so any synthetic re-entry doesn't loop.
  clearTrigger();

  const baseline = document.querySelectorAll(USER_MESSAGE_SELECTORS).length;
  const injected = formatInjection(results, match.source);
  const finalText = `${injected}\n\n${userText}`;

  try {
    replaceInputContent(input, finalText);
    await new Promise((r) => setTimeout(r, 50));
    const sendBtn = findSendButton();
    if (sendBtn) {
      sendBtn.click();
    } else {
      console.warn('[bridge] could not find send button after injection');
    }
  } catch (err) {
    console.warn('[bridge] injection failed', err);
    return;
  }

  const newMsg = await waitForNewUserMessage(baseline, BADGE_WAIT_MS);
  if (newMsg) appendInjectionBadge(newMsg, results);
}

document.addEventListener(
  'keydown',
  (e) => {
    if (injecting) return;
    if (e.key !== 'Enter' || e.shiftKey) return;
    const target = e.target as HTMLElement | null;
    if (!target?.matches?.(INPUT_SELECTOR)) return;
    if (!activeMatch || activeResults.length === 0) return;

    e.preventDefault();
    e.stopPropagation();
    injecting = true;
    void performInjectAndSubmit(target).finally(() => {
      injecting = false;
    });
  },
  true,
);

document.addEventListener(
  'click',
  (e) => {
    if (injecting) return;
    const target = e.target as HTMLElement | null;
    if (!target?.closest?.(SEND_BUTTON_SELECTOR)) return;
    if (!activeMatch || activeResults.length === 0) return;
    const input = findInput();
    if (!input) return;

    e.preventDefault();
    e.stopPropagation();
    injecting = true;
    void performInjectAndSubmit(input).finally(() => {
      injecting = false;
    });
  },
  true,
);
