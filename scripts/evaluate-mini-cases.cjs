'use strict';
// Explicitly authorized real Gemini check of two completed private Codex exec
// runs. No app/PTY/tab mutation, no sending and no other agent invocation.
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const { createMiniOrchestrator } = require('../src/main/mini-orchestrator');
const { createMiniOrchestratorGemini } = require('../src/main/mini-orchestrator-gemini');
const { resolveMiniOrchestratorInstruction } = require('../src/main/mini-orchestrator-runtime');
const { callGeminiApi } = require('../src/main/ipc/gemini-api');
const topic = path.resolve(__dirname, '../docs/tmp/мини-оркестратор-20261030');
function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!['--main-case', '--logs-case', '--generation', '--notes'].includes(flag) || !value || value.startsWith('--') || result[flag]) throw Error('invalid_arguments');
    result[flag] = value;
  }
  const generation = result['--generation'] || 'readonly-v2';
  if (!/^[a-z0-9-]+$/.test(generation)) throw Error('invalid_generation');
  if ((generation !== 'readonly-v2' || result['--main-case'] || result['--logs-case']) && !result['--notes']) throw Error('notes_required_for_new_cases');
  return { generation, mainCase: result['--main-case'] || path.join(topic, 'replay/main-readonly-v2/CASE.json'),
    logsCase: result['--logs-case'] || path.join(topic, 'replay/logs-readonly-v2/trial-upgLI5/CASE.json'), notesFile: result['--notes'] };
}
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const save = (file, value) => fs.writeFile(file, typeof value === 'string' ? value : json(value), { flag: 'wx', mode: 0o600 });
async function nativeProof(c, request, answer) {
  const root = await fs.realpath(c.root), file = await fs.realpath(c.sessionFile);
  if (!file.startsWith(root + path.sep) || !(await fs.lstat(file)).isFile()) throw Error('not_an_own_native_writer');
  const stat = await fs.stat(file);
  if (stat.size > 32 * 1024 * 1024) throw Error('private_source_cap');
  const bytes = await fs.readFile(file); let pos = 0, line = 0, turn = null, user, final, complete;
  for (let end = bytes.indexOf(10, pos); end >= 0; end = bytes.indexOf(10, pos)) {
    const raw = bytes.subarray(pos, end);
    if (raw.length > 1024 * 1024 && /"type"\s*:\s*"compacted"/.test(raw.subarray(0, 180).toString())) {
      line++; pos = end + 1; continue;
    }
    const r = JSON.parse(raw.toString()), p = r.payload || {};
    if (line === 0 && (r.type !== 'session_meta' || p.id !== c.sessionId)) throw Error('native_session_identity_mismatch');
    if (r.type === 'event_msg' && p.type === 'task_started') turn = p.turn_id;
    if (r.type === 'event_msg' && p.type === 'user_message' && turn === c.turnId && p.message === request)
      user = { id: 'codex-user-' + c.sessionId + '-' + line, line, byteOffset: pos, timestamp: r.timestamp, sha256: sha(request) };
    if (turn === c.turnId && r.type === 'response_item' && p.role === 'assistant' && p.phase === 'final_answer') {
      const text = (p.content || []).filter(x => x.type === 'output_text').map(x => x.text || '').join('');
      if (text.trim() === answer.trim()) final = { id: 'codex-assistant-' + c.sessionId + '-' + line, line, byteOffset: pos, timestamp: r.timestamp, text };
    }
    if (r.type === 'event_msg' && p.type === 'task_complete' && p.turn_id === c.turnId) complete = { timestamp: r.timestamp, line, byteOffset: pos };
    line++; pos = end + 1;
  }
  const after = await fs.stat(file);
  if (!user || !final || !complete || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs)
    throw Error('native_completed_pair_not_verified');
  return { file, sha256: sha(bytes), bytes: bytes.length, user, final, complete };
}
async function main() {
  const opts = options(process.argv.slice(2));
  const folder = path.join(topic, 'replay', 'reviews-' + opts.generation);
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const roleText = await fs.readFile(path.join(folder, 'SYSTEM-PROMPT.json'), 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return fs.readFile(path.join(topic, 'replay/reviews-readonly-v2/SYSTEM-PROMPT.json'), 'utf8');
  });
  const role = JSON.parse(roleText);
  const suppliedNotes = opts.notesFile ? JSON.parse(await fs.readFile(opts.notesFile, 'utf8')) : null;
  if (suppliedNotes && !['main', 'logs'].every(name => Array.isArray(suppliedNotes[name]) && suppliedNotes[name].every(note => typeof note === 'string'))) throw Error('invalid_notes');
  const instruction = await resolveMiniOrchestratorInstruction({ prompt: role,
    settings: { model: role.model, thinkingLevel: role.thinkingLevel }, includeFileMetadata: true });
  const envText = await fs.readFile(path.join(require('node:os').homedir(), '.noted-terminal/.env'), 'utf8');
  const key = require('dotenv').parse(envText).GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) throw Error('Gemini_key_not_configured');
  const run = await fs.mkdtemp(path.join(folder, 'run-'));
  await save(path.join(run, 'INSTRUCTION.txt'), instruction.text);
  await save(path.join(run, 'INSTRUCTION.json'), { ...instruction, text: undefined, sha256: sha(instruction.text), providerReceived: false });
  const cases = [
    ['main', opts.mainCase],
    ['logs', opts.logsCase],
  ];
  const results = [];
  for (const [name, caseFile] of cases) {
    const c = JSON.parse(await fs.readFile(caseFile, 'utf8'));
    if (!c.completed) throw Error('case_not_completed:' + name);
    const request = await fs.readFile(c.requestTextFile, 'utf8'), answer = await fs.readFile(c.answerTextFile, 'utf8');
    const proof = await nativeProof(c, request, answer);
    const notes = suppliedNotes ? suppliedNotes[name] : name === 'main' ? [
      'Headless Codex0.166 / gpt-6.1-sol low; исходный effort был max.',
      'Сохранён заполненный контекст. Новых compact и AGENTS carrier нет; историческая AGENTS неизменна.',
      'Скриншот реально прочитан, но shell получил sandbox_apply: Operation not permitted. MCP отключён.',
    ] : [
      'Headless Codex0.166 / gpt-6.1-sol low; исходный effort был max.',
      'Перед новым вопросом произошёл один native compact. Текст AGENTS совпал с историческим.',
      'Shell, unified exec, apps, browser и MCP выключены; live замеры и чтение текущих логов этим стендом недоступны.',
    ];
    const target = path.join(run, name); await fs.mkdir(target, { mode: 0o700 });
    let count = 0;
    const review = createMiniOrchestratorGemini({ callApi: async (system, prompt, model, thinking, options) => {
      const n = ++count, startedAt = Date.now();
      const requestAudit = { model, thinking, systemInstruction: system,
        contents: options.contents || [{ role: 'user', parts: [{ text: prompt }] }],
        tools: options.tools, toolConfig: options.toolConfig, maxOutputTokens: options.maxOutputTokens };
      await save(path.join(target, 'RPC-' + n + '-REQUEST.json'), requestAudit);
      const result = await callGeminiApi(system, prompt, model, thinking, { ...options, apiKey: key });
      await save(path.join(target, 'RPC-' + n + '-RESPONSE.json'), { ...result, startedAt, finishedAt: Date.now() });
      return result;
    } });
    const tabId = c.tabId || 'mini-logs-ro-v2-' + c.sessionId.slice(0, 8);
    const owner = { provider: 'codex', sessionId: c.sessionId, generation: 'headless-exec:' + c.turnId };
    const core = createMiniOrchestrator({ isCurrent: () => true,
      loadInstruction: async () => instruction,
      review: args => review({ ...args, onReadIteration: () => ({ ...args.onReadIteration(), executionEnvironment: notes }) }),
      sendCorrection: () => { throw Error('read_only_reviewer_must_not_send'); },
      persist: (_tab, ledger) => fs.writeFile(path.join(target, 'LEDGER.json'), json(ledger), { mode: 0o600 }),
    });
    core.setEnabled(tabId, true); core.beginTurn({ tabId, owner, turnId: c.turnId });
    core.observeInput({ tabId, owner, turnId: c.turnId, inputId: proof.user.id, text: request });
    const accepted = await core.complete({ tabId, owner, turnId: c.turnId, answerId: proof.final.id,
      answer: proof.final.text, complete: true, sourceVerified: true });
    const snapshot = core.snapshot(tabId);
    await save(path.join(target, 'SNAPSHOT.json'), snapshot);
    await save(path.join(target, 'NATIVE-PROOF.json'), proof);
    const reviewEntry = snapshot.entries.find(e => e.type === 'review');
    if (!accepted || !reviewEntry || count !== 2) throw Error('real_Gemini_review_failed:' + name + ':' + (snapshot.error || 'unknown'));
    await save(path.join(target, 'REVIEW.txt'), reviewEntry.text);
    const archive = { version: 1, tabId, completed: true,
      source: { ...snapshot.reviewSource, verificationNotes: notes }, entries: snapshot.entries };
    await save(path.join(target, 'ARCHIVE.json'), archive);
    const receipt = { caseFile, tabId, sessionId: c.sessionId, turnId: c.turnId, rpcCount: count,
      promptSHA: sha(request), answerSHA: sha(proof.final.text), instructionSHA: sha(instruction.text),
      reviewSHA: sha(reviewEntry.text), model: reviewEntry.reviewMeta?.model,
      thinking: instruction.thinkingLevel, apiReceivedAndReturned: true, automaticSends: 0,
      nativeProof: path.join(target, 'NATIVE-PROOF.json'), archive: path.join(target, 'ARCHIVE.json'), root: c.root };
    await save(path.join(target, 'RESULT.json'), receipt); results.push(receipt); core.dispose();
    console.log('[HeadlessMini] completed ' + name + ' realCodex=true realGemini=true readOnly=true rpc=' + count);
  }
  await save(path.join(run, 'RESULTS.json'), results);
  await fs.writeFile(path.join(folder, 'LATEST.json'), json({ run, results }), { mode: 0o600 });
  console.log('[HeadlessMini] ready ' + run);
}
if (require.main === module) main().catch(error => { console.error('[HeadlessMini] ' + error.message); process.exitCode = 1; });
module.exports = { nativeProof };
