import Dexie, { type Table } from 'dexie';
import type { Chunk, Conversation } from '@/shared/types';

class BridgeDB extends Dexie {
  conversations!: Table<Conversation, string>;
  chunks!: Table<Chunk, string>;

  constructor() {
    super('BridgeDB');
    this.version(1).stores({
      conversations: 'id, platform, project, capturedAt',
      chunks: 'id, conversationId, capturedAt, [conversationId+turnIndex]',
    });
  }
}

export const db = new BridgeDB();

export async function upsertConversation(
  c: Omit<Conversation, 'lastUpdatedAt'>,
): Promise<void> {
  const existing = await db.conversations.get(c.id);
  const now = Date.now();
  const merged: Conversation = {
    ...c,
    capturedAt: existing ? existing.capturedAt : c.capturedAt,
    lastUpdatedAt: now,
  };
  await db.conversations.put(merged);
}

export async function upsertChunk(chunk: Chunk): Promise<void> {
  await db.chunks.put(chunk);
}

export async function getChunksForConversation(
  conversationId: string,
): Promise<Chunk[]> {
  return db.chunks
    .where('[conversationId+turnIndex]')
    .between([conversationId, Dexie.minKey], [conversationId, Dexie.maxKey])
    .toArray();
}

export async function deleteChunksFromTurn(
  conversationId: string,
  fromTurnIndex: number,
): Promise<number> {
  return db.chunks
    .where('[conversationId+turnIndex]')
    .between([conversationId, fromTurnIndex], [conversationId, Dexie.maxKey])
    .delete();
}

export async function clearAll(): Promise<void> {
  await db.transaction('rw', db.conversations, db.chunks, async () => {
    await db.conversations.clear();
    await db.chunks.clear();
  });
}
