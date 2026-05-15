import { ClaudeAdapter } from '@/adapters/claude';
import { chunkTurn } from '@/shared/chunker';
import {
  deleteChunksFromTurn,
  upsertChunk,
  upsertConversation,
} from '@/storage/db';

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
