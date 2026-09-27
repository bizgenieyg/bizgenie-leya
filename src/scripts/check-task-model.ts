import { createTaskAIProvider } from '../providers/ai/index.js';
import { env } from '../config/env.js';

/** One call to GEMINI_TASK_MODEL with the configured key: prints the model and "ok" or the failure code. */
async function main(): Promise<void> {
const ai = createTaskAIProvider();
try {
  const result = await ai.generateReply({ systemPrompt: 'Ответь одним словом: ok', userMessage: 'ping' });
  console.log(`task model ${result.usage?.model ?? env.geminiTaskModel ?? ''}: ok`);
} catch (error) {
  const failure = (error as { failure?: { reason?: string; httpStatus?: number } }).failure;
  console.error(`task model ${env.geminiTaskModel || 'gemini-3.8-flash'}: failed (${failure?.reason ?? 'unknown'}${failure?.httpStatus ? `, HTTP ${failure.httpStatus}` : ''})`);
  process.exitCode = 1;
}
}
void main();
