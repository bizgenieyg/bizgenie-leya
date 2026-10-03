import { readFileSync } from 'node:fs';
import { extractFacts, requiredGaps } from '../services/fact-extraction.service.js';
import { formatMigration } from '../services/knowledge-migration.service.js';
import { requiredTopics } from '../config/knowledge-topics.js';
import { BEHAVIOR_DEFAULTS } from '../config/behavior.js';

const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
/** Keywords the BizGenie base must keep after extraction (task W, п. 4); --expect=a,b,c overrides. */
const BIZGENIE_EXPECTED = ['3-4 дн', 'две недели', 'прекращаете оплату', 'официальном API', 'n8n', 'Нес-Цион', 'неофициальн', 'до запуска'];

/**
 * npm run knowledge:extract-check -- --file=<path> [--sector=автоматизация] [--chunk=2500] [--expect=a,b]
 * Live extraction of one local file (no database): the dry-run report plus keyword and coverage checks.
 * Exit code 1 when a keyword is missing or block coverage is below 95 %.
 */
async function main() {
  const file = arg('file'); if (!file) throw new Error('--file=<path> is required');
  const { createTaskAIProvider, modelKeyConfigured } = await import('../providers/ai/index.js');
  if (!modelKeyConfigured()) throw new Error('GEMINI_API_KEY is not configured');
  const text = readFileSync(file, 'utf8'), sector = arg('sector') ?? 'автоматизация', required = requiredTopics(sector);
  const started = Date.now();
  const extraction = await extractFacts(createTaskAIProvider(), text, [], Number(arg('chunk') ?? BEHAVIOR_DEFAULTS.extraction_chunk_chars), file);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const gaps = requiredGaps(required, extraction.facts.map(f => f.topic), extraction.gaps);
  console.log(formatMigration({ parts: [{ title: file, documentId: null, text, extraction }], gaps, sector, required }));
  const all = extraction.facts.map(f => `${f.text} ${f.quote}`).join('\n').toLowerCase();
  const expected = arg('expect')?.split(',').map(s => s.trim()).filter(Boolean) ?? BIZGENIE_EXPECTED;
  const missing = expected.filter(k => !all.includes(k.toLowerCase()));
  const c = extraction.coverage!, share = c.blocks ? (c.covered + c.skipped.length) / c.blocks : 1;
  console.log(`\nКлючевые слова: ${expected.length - missing.length}/${expected.length}${missing.length ? ` — нет: ${missing.join(', ')}` : ''}`);
  console.log(`Фактов: ${extraction.facts.length}, время: ${seconds} с, модель: ${process.env.GEMINI_TASK_MODEL || 'по умолчанию'}, вызовов: ${extraction.calls?.length ?? 0}`);
  console.log(`Покрытие блоков (с пропусками по причине): ${(share * 100).toFixed(1)} % (порог 95 %)`);
  if (missing.length || share < 0.95) process.exitCode = 1;
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'knowledge:extract-check failed'); process.exitCode = 1; });
