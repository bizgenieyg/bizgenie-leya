/**
 * Structure-aware knowledge splitting: a question with its answer, or a section under a
 * `#`/`##` heading, stays one unit. Oversized units split by paragraph and repeat the heading;
 * unstructured text splits by paragraph without breaking sentences.
 */
const HEADING = /^#{1,3}\s+\S/;
const QUESTION = /^(?:\*\*[^*\n]+\?\*\*\s*$|(?:Q|В|Вопрос|ש)\s*[:.)]\s*\S|[^\n]{3,200}\?\s*$)/i;

export function splitKnowledgeUnits(text: string, maxChars: number): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const units: Array<{ heading: string | null; body: string[] }> = [];
  let heading: string | null = null;
  let current: { heading: string | null; body: string[] } | null = null;
  const flush = () => { if (current && current.body.some(line => line.trim())) units.push(current); current = null; };
  for (const line of lines) {
    const trimmed = line.trim();
    if (HEADING.test(trimmed)) { flush(); heading = trimmed; current = { heading, body: [] }; continue; }
    if (QUESTION.test(trimmed)) { flush(); current = { heading, body: [line] }; continue; }
    if (!current) current = { heading, body: [] };
    current.body.push(line);
  }
  flush();
  const out: string[] = [];
  for (const unit of units) {
    const body = unit.body.join('\n').trim();
    const prefix = unit.heading && !body.startsWith(unit.heading) ? `${unit.heading}\n` : '';
    const whole = `${prefix}${body}`.trim();
    if (whole.length <= maxChars) { out.push(whole); continue; }
    out.push(...splitLong(body, unit.heading, maxChars));
  }
  return out.filter(Boolean);
}

function splitLong(body: string, heading: string | null, maxChars: number): string[] {
  const head = heading ? `${heading}\n` : '';
  const budget = Math.max(200, maxChars - head.length);
  const pieces = body.split(/\n\s*\n/).flatMap(paragraph => paragraph.length <= budget ? [paragraph.trim()] : sentences(paragraph, budget));
  const out: string[] = [];
  let buffer = '';
  for (const piece of pieces) {
    if (!piece) continue;
    if (buffer && buffer.length + piece.length + 2 > budget) { out.push(head + buffer); buffer = ''; }
    buffer = buffer ? `${buffer}\n\n${piece}` : piece;
  }
  if (buffer) out.push(head + buffer);
  return out;
}

function sentences(paragraph: string, budget: number): string[] {
  const parts = paragraph.match(/[^.!?…]+(?:[.!?…]+|$)\s*/g) ?? [paragraph];
  const out: string[] = [];
  let buffer = '';
  for (const part of parts) {
    if (buffer && buffer.length + part.length > budget) { out.push(buffer.trim()); buffer = ''; }
    buffer += part;
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}
