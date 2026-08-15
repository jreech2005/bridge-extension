import type { ClaudeProject, PageState, Turn } from '@/shared/types';

export type TurnHandler = (turn: Turn, edit?: { fromTurnIndex: number }) => void;

const STABILITY_MS = 2000;
const PROJECTS_STORAGE_KEY = 'bridge:claude:projects';
const LOCATION_EVENT = 'bridge:locationchange';

const SELECTORS = {
  chatRoot: ['body'], // No <main> on claude.ai; use body as observer root. Inner logic filters.
  userMessage: ['[data-testid="user-message"]', '[data-user-message-bubble="true"]'],
  assistantMessage: ['.font-claude-response-body'],
  streamingIndicator: ['[data-is-streaming="true"]', 'button[aria-label*="Stop"]', 'button[aria-label*="stop"]'],
};

const SIDEBAR_PROJECT_LINK_SELECTORS = [
  'nav a[href^="/project/"]',
  'aside a[href^="/project/"]',
  '[role="navigation"] a[href^="/project/"]',
  'a[href^="/project/"]',
];
const CONVERSATION_TITLE_SELECTORS = [
  '[data-testid="chat-title-button"]',
  'header [data-testid="chat-title-button"]',
  'header h1',
  'header [class*="title"]',
  'button[data-testid*="conversation"] [class*="truncate"]',
];

// Breadcrumb / non-sidebar project anchors — strategy B reads the project name
// from the top-of-page link the user sees while inside a /chat/<id> within a project.
const BREADCRUMB_PROJECT_SELECTORS = [
  'header a[href^="/project/"]',
  'nav[aria-label*="breadcrumb" i] a[href^="/project/"]',
  '[aria-label*="breadcrumb" i] a[href^="/project/"]',
  'a[href^="/project/"]',
];

const warnedLabels = new Set<string>();

function safeQuery<E extends Element = Element>(
  root: ParentNode,
  selectors: readonly string[],
  label: string,
): E | null {
  for (const sel of selectors) {
    try {
      const el = root.querySelector(sel) as E | null;
      if (el) return el;
    } catch {
      // bad selector — skip
    }
  }
  if (!warnedLabels.has(label)) {
    warnedLabels.add(label);
    console.warn(`[bridge] selector miss: ${label}`);
  }
  return null;
}

function safeQueryAll<E extends Element = Element>(
  root: ParentNode,
  selectors: readonly string[],
): E[] {
  for (const sel of selectors) {
    try {
      const list = root.querySelectorAll(sel);
      if (list.length > 0) return Array.from(list) as E[];
    } catch {
      // skip
    }
  }
  return [];
}

function safeText(el: Element | null): string {
  if (!el) return '';
  const text = (el as HTMLElement).innerText ?? el.textContent ?? '';
  return text.trim();
}

function extractConversationIdFromUrl(url: string): string | null {
  const m = url.match(/\/chat\/([0-9a-f-]{8,})/i);
  return m ? m[1] : null;
}

function extractProjectIdFromUrl(url: string): string | null {
  const m = url.match(/\/project\/([0-9a-f-]{8,})/i);
  return m ? m[1] : null;
}

let historyPatched = false;
function patchHistoryOnce(): void {
  if (historyPatched) return;
  historyPatched = true;
  const fire = () => window.dispatchEvent(new Event(LOCATION_EVENT));
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function (...args: Parameters<typeof history.pushState>) {
    const ret = origPush.apply(this, args);
    fire();
    return ret;
  };
  history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
    const ret = origReplace.apply(this, args);
    fire();
    return ret;
  };
  window.addEventListener('popstate', fire);
}

interface TurnState {
  userText: string;
  assistantText: string;
  emittedAt: number;
}

export class ClaudeAdapter {
  private handler: TurnHandler | null = null;
  private observer: MutationObserver | null = null;
  private chatRoot: Element | null = null;
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  // Last successfully emitted snapshot per turn index — used to detect edits/regenerations.
  private lastByTurn = new Map<number, TurnState>();
  private currentConversationId: string | null = null;
  private rootProbeTimer: ReturnType<typeof setInterval> | null = null;
  private locationListener: (() => void) | null = null;
  private projectCache: ClaudeProject[] = [];
  private dumpedDomForUrl = new Set<string>();
  private projectScrapeObserver: MutationObserver | null = null;
  private projectScrapeDebounce: ReturnType<typeof setTimeout> | null = null;

  onTurn(handler: TurnHandler): void {
    this.handler = handler;
  }

  start(): void {
    patchHistoryOnce();
    this.locationListener = () => this.handleLocationChange();
    window.addEventListener(LOCATION_EVENT, this.locationListener);

    void this.hydrateProjectCacheFromStorage();
    void this.refreshProjectList();
    this.attachProjectScrapeObserver();
    this.handleLocationChange();
  }

  stop(): void {
    if (this.locationListener) {
      window.removeEventListener(LOCATION_EVENT, this.locationListener);
      this.locationListener = null;
    }
    if (this.projectScrapeObserver) {
      this.projectScrapeObserver.disconnect();
      this.projectScrapeObserver = null;
    }
    if (this.projectScrapeDebounce) {
      clearTimeout(this.projectScrapeDebounce);
      this.projectScrapeDebounce = null;
    }
    this.disconnect();
  }

  private attachProjectScrapeObserver(): void {
    if (this.projectScrapeObserver) return;
    // The sidebar mounts asynchronously and can re-render as projects are
    // added/renamed/loaded. Watch document.body and re-scrape on any structural
    // change, debounced to keep cost down.
    this.projectScrapeObserver = new MutationObserver(() => {
      if (this.projectScrapeDebounce) return;
      this.projectScrapeDebounce = setTimeout(() => {
        this.projectScrapeDebounce = null;
        void this.refreshProjectList();
      }, 500);
    });
    try {
      this.projectScrapeObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    } catch (err) {
      console.warn('[bridge] failed to attach project scrape observer', err);
    }
  }

  getPageState(): PageState {
    const url = location.href;
    return {
      platform: 'claude',
      conversationId: extractConversationIdFromUrl(url),
      conversationTitle: this.readConversationTitle(),
      project: this.readActiveProjectName(),
      url,
    };
  }

  private disconnect(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
    if (this.rootProbeTimer) {
      clearInterval(this.rootProbeTimer);
      this.rootProbeTimer = null;
    }
    this.chatRoot = null;
  }

  private handleLocationChange(): void {
    const convId = extractConversationIdFromUrl(location.href);
    if (convId !== this.currentConversationId) {
      this.lastByTurn.clear();
      this.currentConversationId = convId;
    }
    this.disconnect();
    void this.refreshProjectList();
    // Sidebar often mounts after the route resolves — retry once it's likely settled.
    setTimeout(() => void this.refreshProjectList(), 1500);
    this.attachObserver();
  }

  private attachObserver(): void {
    const root = safeQuery(document, SELECTORS.chatRoot, 'chatRoot');
    if (!root) {
      // The SPA may not have mounted yet — probe periodically until the root appears.
      if (!this.rootProbeTimer) {
        this.rootProbeTimer = setInterval(() => {
          if (safeQuery(document, SELECTORS.chatRoot, 'chatRoot')) {
            if (this.rootProbeTimer) {
              clearInterval(this.rootProbeTimer);
              this.rootProbeTimer = null;
            }
            this.attachObserver();
          }
        }, 1000);
      }
      return;
    }
    this.chatRoot = root;
    this.observer = new MutationObserver(() => this.scheduleEmit());
    this.observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    // Kick the timer so already-rendered turns (e.g. on reload) get captured once.
    this.scheduleEmit();
  }

  private scheduleEmit(): void {
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    this.stabilityTimer = setTimeout(() => this.tryEmit(), STABILITY_MS);
  }

  private tryEmit(): void {
    if (!this.handler || !this.chatRoot) return;
    const convId = extractConversationIdFromUrl(location.href);
    if (!convId) return;

    const userMessages = safeQueryAll<HTMLElement>(this.chatRoot, SELECTORS.userMessage);
    const assistantMessages = safeQueryAll<HTMLElement>(this.chatRoot, SELECTORS.assistantMessage);

    const pairCount = Math.min(userMessages.length, assistantMessages.length);
    if (pairCount === 0) return;

    // The latest turn is "in flight" if there's an unpaired user message OR the
    // streaming indicator says the assistant is still generating. In either case,
    // exclude that latest pair from emission and re-arm the stability timer.
    const streaming = this.isStreaming();
    const latestInFlight =
      userMessages.length > assistantMessages.length ||
      (userMessages.length === assistantMessages.length && streaming);

    const emittableCount =
      userMessages.length === assistantMessages.length && streaming
        ? pairCount - 1
        : pairCount;

    if (latestInFlight) {
      this.scheduleEmit();
    }

    if (emittableCount <= 0) return;

    const state = this.getPageState();
    const handler = this.handler;

    for (let idx = 0; idx < emittableCount; idx++) {
      try {
        const userText = (userMessages[idx]!.innerText ?? '').trim();
        const assistantText = (assistantMessages[idx]!.innerText ?? '').trim();
        if (!userText || !assistantText) continue;

        const prior = this.lastByTurn.get(idx);
        if (prior && prior.userText === userText && prior.assistantText === assistantText) {
          continue;
        }

        const isEdit = !!prior && prior.userText !== userText;
        const turn: Turn = {
          platform: 'claude',
          conversationId: convId,
          conversationTitle: state.conversationTitle,
          project: state.project,
          turnIndex: idx,
          userText,
          assistantText,
          url: state.url,
          capturedAt: Date.now(),
        };

        this.lastByTurn.set(idx, { userText, assistantText, emittedAt: turn.capturedAt });
        // On an edit, downstream turns are stale — drop them from local state too so
        // they re-emit when the new versions render.
        if (isEdit) {
          for (const key of Array.from(this.lastByTurn.keys())) {
            if (key > idx) this.lastByTurn.delete(key);
          }
          handler(turn, { fromTurnIndex: idx });
        } else {
          handler(turn);
        }
      } catch (err) {
        console.warn('[bridge] turn extraction failed', err);
      }
    }
  }

  private isStreaming(): boolean {
    for (const sel of SELECTORS.streamingIndicator) {
      try {
        if (document.querySelector(sel)) return true;
      } catch {
        // skip bad selector
      }
    }
    return false;
  }

  private readConversationTitle(): string | null {
    const el = safeQuery(document, CONVERSATION_TITLE_SELECTORS, 'conversationTitle');
    const t = safeText(el);
    return t.length > 0 ? t : null;
  }

  private readActiveProjectName(): string | null {
    const tried: string[] = [];
    let result: string | null = null;
    let winner: string | null = null;

    // Strategy A: URL → cached project list by uuid.
    const directProjectId = extractProjectIdFromUrl(location.href);
    if (directProjectId) {
      tried.push(`A: url /project/${directProjectId} → cache(${this.projectCache.length})`);
      const hit = this.projectCache.find((p) => p.id === directProjectId);
      if (hit?.name) {
        result = hit.name;
        winner = 'A';
      }
    } else {
      tried.push('A: skipped (no /project/<uuid> in URL)');
    }

    // Strategy B: breadcrumb / non-sidebar project anchor.
    if (!result) {
      const convProjectId = this.findChatProjectIdInDom();
      tried.push(
        `B: breadcrumb anchor${convProjectId ? ` → uuid ${convProjectId}` : ''}`,
      );
      if (convProjectId) {
        const cached = this.projectCache.find((p) => p.id === convProjectId);
        if (cached?.name) {
          result = cached.name;
          winner = 'B(cache)';
        }
      }
      if (!result) {
        for (const sel of BREADCRUMB_PROJECT_SELECTORS) {
          try {
            const anchors = document.querySelectorAll<HTMLAnchorElement>(sel);
            for (const a of anchors) {
              // Skip sidebar anchors — those are handled by Strategy C.
              if (a.closest('nav, aside, [role="navigation"]')) continue;
              const name = safeText(a);
              if (name) {
                result = name;
                winner = `B(${sel})`;
                break;
              }
            }
          } catch {
            // skip bad selector
          }
          if (result) break;
        }
      }
    }

    // Strategy C: sidebar entry marked as active/current.
    if (!result) {
      const sidebarLinks = safeQueryAll<HTMLAnchorElement>(
        document,
        SIDEBAR_PROJECT_LINK_SELECTORS,
      );
      tried.push(`C: sidebar active (${sidebarLinks.length} links)`);
      for (const a of sidebarLinks) {
        const current = a.getAttribute('aria-current');
        const isActive =
          current === 'page' ||
          current === 'true' ||
          a.matches('[class*="active"], [class*="selected"]');
        if (!isActive) continue;
        const t = safeText(a);
        if (t) {
          result = t;
          winner = 'C';
          break;
        }
      }
    }

    console.log(
      `[bridge debug] project detection: tried ${tried.join(' | ')}, result: ${
        result ?? 'null'
      }${winner ? ` (strategy ${winner})` : ''}`,
    );

    if (!result && !this.dumpedDomForUrl.has(location.href)) {
      this.dumpedDomForUrl.add(location.href);
      const header = document.querySelector('header');
      const sidebar =
        document.querySelector('aside') ??
        document.querySelector('nav') ??
        document.querySelector('[role="navigation"]');
      console.warn('[bridge debug] project detection: all strategies failed', {
        url: location.href,
        headerOuterHTML: header?.outerHTML?.slice(0, 4000) ?? null,
        sidebarOuterHTML: sidebar?.outerHTML?.slice(0, 4000) ?? null,
      });
    }

    return result;
  }

  // Returns the project uuid linked from a non-sidebar anchor (breadcrumb), if any.
  private findChatProjectIdInDom(): string | null {
    const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href^="/project/"]');
    for (const a of anchors) {
      if (a.closest('nav, aside, [role="navigation"]')) continue;
      const m = a.getAttribute('href')?.match(/\/project\/([0-9a-f-]{8,})/i);
      if (m) return m[1] ?? null;
    }
    return null;
  }

  private async hydrateProjectCacheFromStorage(): Promise<void> {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
      const got = await chrome.storage.local.get(PROJECTS_STORAGE_KEY);
      const list = (got?.[PROJECTS_STORAGE_KEY] as ClaudeProject[] | undefined) ?? [];
      if (list.length > 0) this.projectCache = list;
    } catch (err) {
      console.warn('[bridge] project cache hydrate failed', err);
    }
  }

  private async refreshProjectList(): Promise<void> {
    try {
      // Broad scope: any project anchor anywhere in the document. The sidebar
      // markup churns (nav vs aside vs role=navigation), but the href pattern
      // is stable. Dedupe by uuid handles breadcrumb/sidebar overlap.
      const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href^="/project/"]');
      const seen = new Set<string>();
      const projects: ClaudeProject[] = [];
      for (const a of anchors) {
        const href = a.getAttribute('href') ?? '';
        const id = href.match(/\/project\/([^/?#]+)/)?.[1];
        if (!id || seen.has(id)) continue;
        const name = safeText(a);
        if (!name) continue;
        seen.add(id);
        projects.push({ id, name, url: new URL(href, location.origin).toString() });
      }

      console.log(
        `[bridge debug] project list scrape: found ${projects.length} projects:`,
        projects.map((p) => p.name),
      );

      if (projects.length === 0) return;

      // Merge new findings into the in-memory cache so previously-seen projects
      // survive page states where the sidebar collapses or hides them.
      const merged = new Map<string, ClaudeProject>();
      for (const p of this.projectCache) merged.set(p.id, p);
      for (const p of projects) merged.set(p.id, p);
      this.projectCache = Array.from(merged.values());

      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        await chrome.storage.local.set({ [PROJECTS_STORAGE_KEY]: this.projectCache });
      }
    } catch (err) {
      console.warn('[bridge] project list refresh failed', err);
    }
  }
}
