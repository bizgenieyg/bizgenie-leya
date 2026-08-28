export interface KnowledgeCandidate {
  id: string;
  question: string | null;
  answer: string;
}

export type KnowledgeResult =
  | { matched: false; answer: null; escalate: true }
  | { matched: true; answer: string; escalate: false; knowledgeItemId: string };

function normalizeQuestion(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

export function findExactKnowledgeAnswer(
  question: string,
  candidates: KnowledgeCandidate[],
): KnowledgeResult {
  const normalizedQuestion = normalizeQuestion(question);
  const match = candidates.find(
    (candidate) =>
      candidate.question !== null &&
      normalizeQuestion(candidate.question) === normalizedQuestion,
  );

  if (!match) {
    return { matched: false, answer: null, escalate: true };
  }

  return {
    matched: true,
    answer: match.answer,
    escalate: false,
    knowledgeItemId: match.id,
  };
}
