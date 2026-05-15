import type { Chunk, Turn } from '@/shared/types';

const MAX_TOKENS = 500;

export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash =
      (hash +
        ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>>
      0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function chunkId(
  conversationId: string,
  turnIndex: number,
  chunkIndex: number,
): string {
  return fnv1a(`${conversationId}:${turnIndex}:${chunkIndex}`);
}

// Splits text into atomic blocks: each block is either a complete fenced code block
// (preserving its fences) or a paragraph of prose. Code blocks are never broken up.
function splitIntoBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[] = [];
  let buf: string[] = [];
  let inFence = false;

  const flushParagraph = () => {
    if (buf.length === 0) return;
    const para = buf.join('\n').replace(/^\n+|\n+$/g, '');
    if (para.length > 0) blocks.push(para);
    buf = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const isFenceLine = trimmed.startsWith('```');
    if (!inFence) {
      if (isFenceLine) {
        flushParagraph();
        buf.push(line);
        inFence = true;
      } else if (trimmed === '') {
        flushParagraph();
      } else {
        buf.push(line);
      }
    } else {
      buf.push(line);
      if (isFenceLine) {
        blocks.push(buf.join('\n'));
        buf = [];
        inFence = false;
      }
    }
  }

  if (buf.length > 0) {
    if (inFence) {
      // Unterminated fence — keep as one block to honor "never split inside code".
      blocks.push(buf.join('\n'));
    } else {
      flushParagraph();
    }
  }
  return blocks;
}

function buildChunk(turn: Turn, chunkIndex: number, assistantSlice: string): Chunk {
  const combined = `User: ${turn.userText}\n\nAssistant: ${assistantSlice}`;
  return {
    id: chunkId(turn.conversationId, turn.turnIndex, chunkIndex),
    conversationId: turn.conversationId,
    turnIndex: turn.turnIndex,
    chunkIndex,
    userText: turn.userText,
    assistantText: assistantSlice,
    combinedText: combined,
    tokenCount: approxTokens(combined),
    vector: null,
    capturedAt: turn.capturedAt,
  };
}

export function chunkTurn(turn: Turn): Chunk[] {
  const combinedFull = `User: ${turn.userText}\n\nAssistant: ${turn.assistantText}`;
  if (approxTokens(combinedFull) <= MAX_TOKENS) {
    return [buildChunk(turn, 0, turn.assistantText)];
  }

  const blocks = splitIntoBlocks(turn.assistantText);
  if (blocks.length <= 1) {
    return [buildChunk(turn, 0, turn.assistantText)];
  }

  const userOverhead = approxTokens(`User: ${turn.userText}\n\nAssistant: `);
  const budget = Math.max(50, MAX_TOKENS - userOverhead);

  const chunks: Chunk[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const block of blocks) {
    const blockTokens = approxTokens(block);
    if (current.length > 0 && currentTokens + blockTokens > budget) {
      chunks.push(buildChunk(turn, chunks.length, current.join('\n\n')));
      current = [];
      currentTokens = 0;
    }
    current.push(block);
    currentTokens += blockTokens;
  }
  if (current.length > 0) {
    chunks.push(buildChunk(turn, chunks.length, current.join('\n\n')));
  }
  return chunks;
}
