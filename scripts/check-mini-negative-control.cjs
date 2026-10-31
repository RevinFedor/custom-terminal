'use strict';
// Explicit synthetic negative control of REAL Gemini, not a claimed Codex
// failure and never imported as a genuine session or sent to another tab.
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { createMiniOrchestratorGemini } = require('../src/main/mini-orchestrator-gemini');
const { callGeminiApi } = require('../src/main/ipc/gemini-api');
const topic = path.resolve(__dirname, '../docs/tmp/мини-оркестратор-20261030');
async function main() {
  const latest = JSON.parse(await fs.readFile(path.join(topic, 'replay/reviews-readonly-v2/LATEST.json'), 'utf8'));
  const instruction = { ...JSON.parse(await fs.readFile(path.join(latest.run, 'INSTRUCTION.json'), 'utf8')),
    text: await fs.readFile(path.join(latest.run, 'INSTRUCTION.txt'), 'utf8') };
  const dir = await fs.mkdtemp(path.join(latest.run, 'CONTROL-SYNTHETIC-NOT-CODEX-'));
  const request = await fs.readFile(path.join(topic, 'replay/main-readonly-v2/PROMPT.txt'), 'utf8');
  const answer = 'Всё нормально. Работайте дальше.';
  const key = require('dotenv').parse(await fs.readFile(path.join(os.homedir(), '.noted-terminal/.env'), 'utf8')).GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) throw Error('Gemini_key_missing');
  let n = 0;
  const review = createMiniOrchestratorGemini({ callApi: async (s, p, m, t, options) => {
    const index = ++n;
    await fs.writeFile(path.join(dir, 'RPC-' + index + '-REQUEST.json'), JSON.stringify({ controlled: true,
      nativeCodex: false, system: s, model: m, thinking: t,
      contents: options.contents || [{ role: 'user', parts: [{ text: p }] }], tools: options.tools, toolConfig: options.toolConfig }, null, 2), { flag: 'wx', mode: 0o600 });
    const result = await callGeminiApi(s, p, m, t, { ...options, apiKey: key });
    await fs.writeFile(path.join(dir, 'RPC-' + index + '-RESPONSE.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
    return result;
  } });
  const result = await review({ instruction, inputs: [{ inputId: 'controlled-input', text: request }], answer,
    owner: { provider: 'codex', sessionId: 'synthetic-negative-control-NOT-native', generation: 'controlled-fixture' },
    turnId: 'controlled-only', jobId: crypto.randomUUID() });
  const rejected = !/^Запрос выполнен\s*:/i.test(result.text) && /не выполнен|не закрыт|не ответ|недоч[её]т|пропущ|не раскры|не разобра|упущ/i.test(result.text);
  await fs.writeFile(path.join(dir, 'RESULT.json'), JSON.stringify({ controlled: true, realGemini: true, realCodex: false,
    fabricatedAnswerExplicit: true, instructionSHA: crypto.createHash('sha256').update(instruction.text).digest('hex'),
    rpcCount: n, rejected, text: result.text, sends: 0 }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log('[MiniControl] ' + JSON.stringify({ dir, realGemini: true, realCodex: false, rejected, rpcCount: n, sends: 0 }));
  if (!rejected) process.exitCode = 1;
}
main().catch(error => { console.error('[MiniControl] ' + error.message); process.exitCode = 1; });
