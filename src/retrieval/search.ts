import { db } from '@/storage/db';
import { embedInContentScript } from '@/embeddings/embedder-cs';
import type {
  Chunk,
  Conversation,
  SearchResult,
  TriggerMatch,
} from '@/shared/types';

const DEFAULT_THRESHOLD = 0.6;
const DEFAULT_TOP_N = 3;
const DEFAULT_TOKEN_BUDGET = 2000;
const DEDUPE_THRESHOLD = 0.92;

function cosine(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function searchChunks(
  queryText: string,
  source: TriggerMatch['source'],
  opts: { threshold?: number; topN?: number; tokenBudget?: number } = {},
): Promise<SearchResult[]> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const tokenBudget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;

  const conversations: Conversation[] =
    source.type === 'platform'
      ? await db.conversations.where('platform').equals(source.platform).toArray()
      : await db.conversations.where('project').equals(source.project).toArray();

  console.log(
    '[bridge debug] retrieval: source=', source,
    `conversations matched=${conversations.length}`,
  );

  if (conversations.length === 0) return [];

  const conversationById = new Map(conversations.map((c) => [c.id, c]));

  const chunks: Chunk[] = await db.chunks
    .where('conversationId')
    .anyOf(conversations.map((c) => c.id))
    .toArray();

  const embedded = chunks.filter((c) => c.vector != null);
  console.log(
    `[bridge debug] retrieval: chunks=${chunks.length}, embedded=${embedded.length}`,
  );
  if (embedded.length === 0) return [];

  const queryVec = await embedInContentScript(queryText);
  console.log('[bridge debug] retrieval: queryEmbed done, dims=', queryVec.length);

  const allScored: SearchResult[] = embedded
    .map((chunk) => {
      const conv = conversationById.get(chunk.conversationId);
      if (!conv) return null;
      return {
        chunk,
        conversation: conv,
        score: cosine(queryVec, chunk.vector as Float32Array),
      } satisfies SearchResult;
    })
    .filter((r): r is SearchResult => r !== null);

  const scored = allScored
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score);

  console.log(
    `[bridge debug] retrieval: found ${allScored.length} candidates,`,
    `after threshold ${scored.length}`,
  );

  // Greedy dedupe + topN cap
  const kept: SearchResult[] = [];
  for (const r of scored) {
    let dup = false;
    for (const k of kept) {
      if (cosine(r.chunk.vector as Float32Array, k.chunk.vector as Float32Array) > DEDUPE_THRESHOLD) {
        dup = true;
        break;
      }
    }
    if (!dup) kept.push(r);
    if (kept.length >= topN) break;
  }

  console.log(`[bridge debug] retrieval: after dedup ${kept.length}`);

  // Token budget — drop lowest-scoring (tail) until under budget, but always keep the top one.
  const final: SearchResult[] = [];
  let total = 0;
  for (const r of kept) {
    if (final.length > 0 && total + r.chunk.tokenCount > tokenBudget) break;
    final.push(r);
    total += r.chunk.tokenCount;
  }
  console.log(`[bridge debug] retrieval: after token budget ${final.length}`);
  return final;
}
