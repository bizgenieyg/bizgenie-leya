import assert from "node:assert/strict";
import test from "node:test";

import { groupTopUnknownQuestions } from "./reports.utils.js";

test("groups unknown questions by exact input and ranks by count", () => {
  assert.deepEqual(
    groupTopUnknownQuestions([
      { input: "Do you have parking?", output: "msg-1" },
      { input: "Do you deliver?", output: "msg-2" },
      { input: "Do you have parking?", output: "msg-3" },
      { input: "", output: "msg-4" },
      { input: null, output: "msg-5" },
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
      [
        { input: "B", output: "msg-1" },
        { input: "A", output: "msg-2" },
        { input: "C", output: "msg-3" },
      ],
      2,
    ),
    [
      { question: "A", count: 1 },
      { question: "B", count: 1 },
    ],
  );
});

test("excludes queued escalation rows with no delivery output", () => {
  assert.deepEqual(
    groupTopUnknownQuestions(
      [
        { input: "Do you have parking?", output: null },
        { input: "Do you have parking?", output: "owner-msg-1" },
      ],
      5,
    ),
    [{ question: "Do you have parking?", count: 1 }],
  );
});
