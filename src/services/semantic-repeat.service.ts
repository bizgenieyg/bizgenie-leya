import type { EmbeddingProvider } from '../providers/embedding/embedding-provider.interface.js';

export interface SemanticRepeat { repeat: boolean; similarity: number | null }
const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/**
 * A reply that says the same as one of the last bot replies in other words: embeddings (SEMANTIC_SIMILARITY)
 * and cosine similarity against each of them. A failing embedding never blocks the reply (log only).
 */
export async function isSemanticRepeat(reply: string, previous: string[], embedder: EmbeddingProvider | null, threshold: number,
  onUsage?: (usage: { model: string; inputTokens: number }) => Promise<void>): Promise<SemanticRepeat> {
  const others = previous.filter(text => text.trim());
  if (!embedder || !reply.trim() || !others.length) return { repeat: false, similarity: null };
  try {
    const { vectors, inputTokens } = await embedder.embed([reply, ...others], 'SEMANTIC_SIMILARITY');
    await onUsage?.({ model: embedder.model, inputTokens: inputTokens ?? Math.ceil([reply, ...others].join(' ').length / 4) });
    const [first, ...rest] = vectors;
    if (!first || rest.length !== others.length) return { repeat: false, similarity: null };
    const similarity = Math.max(...rest.map(vector => cosine(first, vector)));
    return { repeat: similarity >= threshold, similarity };
  } catch {
    console.warn('semantic_repeat_check_failed');
    return { repeat: false, similarity: null };
  }
}
