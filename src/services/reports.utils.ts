export interface UnknownQuestionRow {
  input: string | null;
}

export interface UnknownQuestionCount {
  question: string;
  count: number;
}

export function groupTopUnknownQuestions(
  rows: UnknownQuestionRow[],
  limit: number,
): UnknownQuestionCount[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.input !== "string" || row.input.trim() === "") continue;
    counts.set(row.input, (counts.get(row.input) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([question, count]) => ({ question, count }))
    .sort((left, right) => right.count - left.count || left.question.localeCompare(right.question))
    .slice(0, limit);
}
