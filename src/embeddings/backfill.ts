import { db } from '@/storage/db';
import type { Chunk } from '@/shared/types';
import { embedInContentScript } from './embedder-cs';

const LOCK_KEY = 'bridge:backfill:lock';
const CURSOR_KEY = 'bridge:backfill:cursor';
const BATCH_SIZE = 5;
const TICK_INTERVAL_MS = 30_000;
const STARTUP_DELAY_MS = 5_000;
const LOCK_STALE_MS = 60_000;

interface CursorRecord {
  capturedAt: number;
}

interface LockRecord {
  tabId: string;
  heartbeat: number;
}

const SELF_ID: string =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `tab-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

async function readCursor(): Promise<number> {
  const got = await chrome.storage.local.get(CURSOR_KEY);
  const rec = got?.[CURSOR_KEY] as CursorRecord | undefined;
  return typeof rec?.capturedAt === 'number' ? rec.capturedAt : Number.MAX_SAFE_INTEGER;
}

async function writeCursor(capturedAt: number): Promise<void> {
  await chrome.storage.local.set({ [CURSOR_KEY]: { capturedAt } satisfies CursorRecord });
}

async function readLock(): Promise<LockRecord | null> {
  const got = await chrome.storage.local.get(LOCK_KEY);
  return (got?.[LOCK_KEY] as LockRecord | undefined) ?? null;
}

async function writeLock(rec: LockRecord): Promise<void> {
  await chrome.storage.local.set({ [LOCK_KEY]: rec });
}

async function clearLockIfMine(): Promise<void> {
  try {
    const existing = await readLock();
    if (existing?.tabId === SELF_ID) {
      await chrome.storage.local.remove(LOCK_KEY);
    }
  } catch {
    // best effort during unload
  }
}

async function tryAcquireLock(): Promise<boolean> {
  const existing = await readLock();
  const now = Date.now();
  const acquirable =
    !existing ||
    existing.tabId === SELF_ID ||
    now - existing.heartbeat > LOCK_STALE_MS;
  if (!acquirable) return false;
  await writeLock({ tabId: SELF_ID, heartbeat: now });
  // Re-read to settle a last-writer-wins race with another tab acquiring at the same instant.
  const after = await readLock();
  return after?.tabId === SELF_ID;
}

async function refreshHeartbeat(): Promise<boolean> {
  const existing = await readLock();
  if (existing?.tabId !== SELF_ID) return false;
  await writeLock({ tabId: SELF_ID, heartbeat: Date.now() });
  return true;
}

async function nextBatch(cursor: number): Promise<Chunk[]> {
  const collected: Chunk[] = [];
  await db.chunks
    .where('capturedAt')
    .below(cursor)
    .reverse()
    .until(() => collected.length >= BATCH_SIZE)
    .each((c) => {
      if (c.vector == null) collected.push(c);
    });
  return collected;
}

async function runOnce(): Promise<{ processed: number }> {
  let cursor = await readCursor();
  let batch = await nextBatch(cursor);

  // Watermark exhausted — sweep again from the top to pick up chunks added since.
  if (batch.length === 0 && cursor !== Number.MAX_SAFE_INTEGER) {
    cursor = Number.MAX_SAFE_INTEGER;
    await writeCursor(cursor);
    batch = await nextBatch(cursor);
  }

  if (batch.length === 0) return { processed: 0 };

  let processed = 0;
  let oldestProcessed = cursor;

  for (const chunk of batch) {
    try {
      const vector = await embedInContentScript(chunk.combinedText);
      await db.chunks.update(chunk.id, { vector });
      processed++;
    } catch (err) {
      console.warn('[bridge] backfill embed failed for', chunk.id, err);
    }
    // Advance cursor regardless — failed chunks shouldn't poison the queue.
    if (chunk.capturedAt < oldestProcessed) oldestProcessed = chunk.capturedAt;
  }

  await writeCursor(oldestProcessed);
  return { processed };
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let started = false;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const heldByMe = await refreshHeartbeat();
    if (!heldByMe) {
      const acquired = await tryAcquireLock();
      if (!acquired) return; // another tab owns the backfill
    }
    const { processed } = await runOnce();
    if (processed > 0) {
      console.log('[bridge] backfill processed', processed, 'chunk(s)');
    }
  } catch (err) {
    console.warn('[bridge] backfill tick failed', err);
  } finally {
    running = false;
  }
}

export function startBackfill(): void {
  if (started) return;
  started = true;

  setTimeout(() => {
    void tick();
    intervalHandle = setInterval(() => void tick(), TICK_INTERVAL_MS);
  }, STARTUP_DELAY_MS);

  window.addEventListener('beforeunload', () => {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    void clearLockIfMine();
  });
}
