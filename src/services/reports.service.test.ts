import assert from "node:assert/strict";
import test from "node:test";

import { groupTopUnknownQuestions } from "./reports.utils.js";

test("groups unknown questions by exact input and ranks by count", () => {
  assert.deepEqual(
    groupTopUnknownQuestions([
      { input: "Do you have parking?" },
      { input: "Do you deliver?" },
      { input: "Do you have parking?" },
      { input: "" },
      { input: null },
    ], 5),
    [
      { question: "Do you have parking?", count: 2 },
      { question: "Do you deliver?", count: 1 },
    ],
  );
});

test("limits the top unknown questions", () => {
  assert.deepEqual(
    groupTopUnknownQuestions(
      [{ input: "B" }, { input: "A" }, { input: "C" }],
      2,
    ),
    [
      { question: "A", count: 1 },
      { question: "B", count: 1 },
    ],
  );
});
