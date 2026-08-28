import { normalizeText } from "../utils/normalize.js";

export interface KnowledgeCandidate {
  id: string;
  question: string | null;
  answer: string;
}

export type KnowledgeResult =
  | { matched: false; answer: null; escalate: true }
  | { matched: true; answer: string; escalate: false; knowledgeItemId: string };

export function findExactKnowledgeAnswer(
  question: string,
  candidates: KnowledgeCandidate[],
): KnowledgeResult {
  const normalizedQuestion = normalizeText(question);
  const match = candidates.find(
    (candidate) =>
      candidate.question !== null &&
      normalizeText(candidate.question) === normalizedQuestion,
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
