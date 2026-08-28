import assert from "node:assert/strict";
import test from "node:test";

import { findExactKnowledgeAnswer } from "./knowledge.service.js";

const faq = [{ id: "faq-1", question: "When are you open?", answer: "Sunday to Thursday." }];

test("returns an exact FAQ answer after safe normalization", () => {
  assert.deepEqual(findExactKnowledgeAnswer("  WHEN   are you OPEN? ", faq), {
    matched: true,
    answer: "Sunday to Thursday.",
    escalate: false,
    knowledgeItemId: "faq-1",
  });
});

test("escalates an unknown question without inventing an answer", () => {
  assert.deepEqual(findExactKnowledgeAnswer("Do you offer parking?", faq), {
    matched: false,
    answer: null,
    escalate: true,
  });
});
