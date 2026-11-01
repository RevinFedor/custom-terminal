'use strict';
// One explicitly requested, blind review of an actual completed archived turn.
// No model-error injection, UI launch, source mutation, or automatic correction.
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const { nativeProof } = require('./evaluate-mini-cases.cjs');
const { createMiniOrchestrator } = require('../src/main/mini-orchestrator');
const { createMiniOrchestratorGemini } = require('../src/main/mini-orchestrator-gemini');
const { resolveMiniOrchestratorInstruction } = require('../src/main/mini-orchestrator-runtime');
const { callGeminiApi } = require('../src/main/ipc/gemini-api');
const topic = path.resolve(__dirname, '../docs/tmp/мини-оркестратор-20261030');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const save = (file, value) => fs.writeFile(file, typeof value === 'string' ? value : json(value), { flag: 'wx', mode: 0o600 });
async function boundedJson(file, cap) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > cap) throw Error('evidence_file_invalid');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function main() {
  const args = process.argv.slice(2), decisionOnly = args.at(-1) === '--decision-only';
  if (decisionOnly) args.pop();
  const [caseFile, generation, actionFile, primaryFile] = args;
  if (!caseFile || !/^[a-z0-9-]+$/.test(generation || '') || args.length < 2 || args.length > 4) throw Error('usage: case.json generation [related-actions.json] [primary-context.json] [--decision-only]');
  const c = await boundedJson(caseFile, 256 * 1024);
  if (!c.completed) throw Error('archived_turn_not_completed');
  const request = await fs.readFile(c.requestTextFile, 'utf8'), answer = await fs.readFile(c.answerTextFile, 'utf8');
  if (request.length > 250000 || answer.length > 250000) throw Error('pair_limit');
  const proof = await nativeProof(c, request, answer);
  const additionalInputs = c.additionalInputsFile ? await boundedJson(c.additionalInputsFile, 32 * 1024) : [];
  if (!Array.isArray(additionalInputs) || additionalInputs.length > 15) throw Error('additional_inputs_invalid');
  if (additionalInputs.length) {
    const lines = (await fs.readFile(proof.file, 'utf8')).trimEnd().split('\n');
    let turn = null;
    const turns = lines.map(line => { const r = JSON.parse(line); if (r.type === 'event_msg' && r.payload?.type === 'task_started') turn = r.payload.turn_id; return turn; });
    for (const row of additionalInputs) {
      const p = JSON.parse(lines[row.rawLine] || '{}').payload || {};
      if (!Number.isInteger(row.rawLine) || row.rawLine <= proof.user.line || row.rawLine >= proof.final.line
        || turns[row.rawLine] !== c.turnId || p.type !== 'user_message' || p.message !== row.text
        || row.id !== 'codex-user-' + c.sessionId + '-' + row.rawLine) throw Error('additional_input_source_mismatch');
    }
  }
  const relatedActions = actionFile ? await boundedJson(actionFile, 64 * 1024) : null;
  if (relatedActions && (relatedActions.source?.ownSessionId !== c.sessionId
    || relatedActions.source?.targetTurnId !== c.turnId || relatedActions.source?.sha256 !== proof.sha256)) throw Error('action_evidence_owner_mismatch');
  const contextFile = c.previousContextFile || c.antecedentsFile;
  let previousContext = contextFile ? await boundedJson(contextFile, 128 * 1024) : null;
  if (primaryFile) {
    const context = await boundedJson(primaryFile, 32 * 1024);
    if (context.source?.ownSessionId !== c.sessionId || context.source?.sessionSHA256 !== proof.sha256
      || context.source?.targetUserExcluded !== proof.user.line || !Array.isArray(context.chronology)
      || context.chronology.length > 16) throw Error('primary_context_owner_mismatch');
    // Only literal pre-existing data goes to the model. Do not relay the
    // preparer's findings, labels of obligations, or a desired verdict.
    const lines = (await fs.readFile(proof.file, 'utf8')).trimEnd().split('\n');
    for (const row of context.chronology) {
      if (!Number.isInteger(row.rawLine) || row.rawLine < 1 || row.rawLine >= proof.user.line
        || sha(lines[row.rawLine] || '') !== row.rawRecordSHA256) throw Error('primary_context_record_changed');
      const record = JSON.parse(lines[row.rawLine]), p = record.payload || {};
      const text = p.type === 'user_message' ? p.message : (p.content || []).map(part => part.text || '').join('');
      if (text !== row.text) throw Error('primary_context_text_changed');
    }
    previousContext = { kind: 'literal preceding task and clarifications, not new requirements',
      source: context.source, chronology: context.chronology };
  }
  const roleFile = path.join(topic, 'replay/reviews-readonly-v2/SYSTEM-PROMPT.json');
  const role = await boundedJson(roleFile, 32 * 1024);
  if (role.id !== 'mini-orchestrator-review' || role.revision !== 'a67240589decf6317bc48aca') throw Error('role_snapshot_changed');
  const instruction = await resolveMiniOrchestratorInstruction({ prompt: role,
    settings: { model: role.model, thinkingLevel: role.thinkingLevel }, includeFileMetadata: true, automaticCorrections: decisionOnly });
  const folder = path.join(topic, 'replay', 'reviews-' + generation);
  await fs.mkdir(folder, { recursive: false, mode: 0o700 });
  await save(path.join(folder, 'ATTEMPT-START.json'), { startedAt: new Date().toISOString(), caseFile,
    originalQuestionUnchanged: true, blindReview: true, expectedVerdictSupplied: false,
    providerRunInThisTrial: !c.historicalCopiedCompleted, automaticCorrection: false,
    ...(relatedActions ? { actionFile: path.resolve(actionFile), actionFileSHA: sha(await fs.readFile(actionFile)) } : {}),
    ...(primaryFile ? { primaryFile: path.resolve(primaryFile), primaryFileSHA: sha(await fs.readFile(primaryFile)) } : {}),
    ...(c.additionalInputsFile ? { additionalInputsFile: c.additionalInputsFile, additionalInputsSHA: sha(await fs.readFile(c.additionalInputsFile)) } : {}) });
  await save(path.join(folder, 'INSTRUCTION.txt'), instruction.text);
  await save(path.join(folder, 'INSTRUCTION.json'), { ...instruction, text: undefined,
    sha256: sha(instruction.text), providerReceived: false });
  const env = require('dotenv').parse(await fs.readFile(path.join(require('node:os').homedir(), '.noted-terminal/.env'), 'utf8'));
  const key = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) throw Error('Gemini_key_not_configured');
  let rpcCount = 0;
  const reviewer = createMiniOrchestratorGemini({ automaticCorrections: decisionOnly, callApi: async (system, prompt, model, thinking, options) => {
    const n = ++rpcCount;
    await save(path.join(folder, 'RPC-' + n + '-REQUEST.json'), { model, thinking, systemInstruction: system,
      contents: options.contents || [{ role: 'user', parts: [{ text: prompt }] }], tools: options.tools,
      toolConfig: options.toolConfig, maxOutputTokens: options.maxOutputTokens });
    const startedAt = Date.now();
    const result = await callGeminiApi(system, prompt, model, thinking, { ...options, apiKey: key });
    await save(path.join(folder, 'RPC-' + n + '-RESPONSE.json'), { ...result, startedAt, finishedAt: Date.now() });
    return result;
  } });
  const owner = { provider: 'codex', sessionId: c.sessionId, generation: 'archived-source:' + c.turnId };
  const tabId = c.tabId;
  let decision, forwardInvocations = 0;
  const core = createMiniOrchestrator({ automaticCorrections: decisionOnly, isCurrent: () => true, loadInstruction: async () => instruction,
    review: async args => decision = await reviewer({ ...args, onReadIteration: () => ({ ...args.onReadIteration(),
      ...(previousContext ? { previousContext } : {}),
      ...(relatedActions ? { relatedActions } : {}),
      executionEnvironment: [c.historicalCopiedCompleted
        ? 'Это точная копия завершённого исторического ответа. Новый Codex не генерировал этот ответ.'
        : 'Это новый завершённый Codex exec; оригинальная пользовательская сессия не изменялась.',
      'Последующие пользовательские требования не включены. Ожидаемый вердикт не задан.',
      'Изображение, если оно упомянуто в запросе, не входит в этот текстовый снимок. Не утверждай, что просмотрел его.'] }) }),
    sendCorrection: async request => {
      if (!decisionOnly) throw Error('read_only_reviewer_must_not_send');
      if (request.tabId !== tabId || request.owner.sessionId !== c.sessionId || request.isCurrent() !== true || ++forwardInvocations !== 1) throw Error('decision_smoke_owner_mismatch');
      await save(path.join(folder, 'PROPOSED-CORRECTION.json'), { tabId, sessionId: c.sessionId, jobId: request.jobId, handoffId: request.handoffId, prompt: request.prompt });
      // Explicit transport substitute: no App was launched and no input was
      // written. Never call this a delivered MCP correction or real Main proof.
      return { status: 'no-input', error: 'headless_decision_smoke_no_app_writer' };
    },
    persist: (_tab, ledger) => fs.writeFile(path.join(folder, 'LEDGER.json'), json(ledger), { mode: 0o600 }),
  });
  try {
    core.setEnabled(tabId, true); core.beginTurn({ tabId, owner, turnId: c.turnId });
    core.observeInput({ tabId, owner, turnId: c.turnId, inputId: proof.user.id, text: request });
    for (const row of additionalInputs) core.observeInput({ tabId, owner, turnId: c.turnId, inputId: row.id, text: row.text });
    const accepted = await core.complete({ tabId, owner, turnId: c.turnId, answerId: proof.final.id,
      answer: proof.final.text, complete: true, sourceVerified: true });
    const snapshot = core.snapshot(tabId);
    await save(path.join(folder, 'SNAPSHOT.json'), snapshot);
    await save(path.join(folder, 'NATIVE-PROOF.json'), proof);
    const review = snapshot.entries.find(entry => entry.type === 'review');
    if (!accepted || !review || rpcCount !== 2) throw Error('review_not_completed:' + (snapshot.error || 'unknown'));
    await save(path.join(folder, 'REVIEW.txt'), review.text);
    if (decisionOnly) {
      if (forwardInvocations !== (decision.verdict === 'needs_correction' ? 1 : 0)) throw Error('automatic_decision_forward_mismatch');
      await save(path.join(folder, 'DECISION.json'), decision);
      await save(path.join(folder, 'RESULT.json'), { caseFile, sessionId: c.sessionId, rpcCount, verdict: decision.verdict,
        actualGemini: true, actualCore: true, forwardInvocations, inputWrites: 0, mcpCalls: 0,
        ownerCheck: 'controlled headless fixture, NOT live Main lifecycle proof', instructionSHA: sha(instruction.text) });
      console.log('[MiniAutomaticDecision] actualGemini=true actualCore=true forward=' + forwardInvocations + ' inputWrites=0');
      return;
    }
    const archiveFile = path.join(folder, 'ARCHIVE.json');
    await save(archiveFile, { version: 1, tabId, completed: true, source: { ...snapshot.reviewSource,
      verificationNotes: [c.historicalCopiedCompleted ? 'Исходный ответ скопирован из настоящей завершённой исторической итерации; не новая генерация.' : 'Исправленный ответ получен настоящим Codex exec.'] }, entries: snapshot.entries });
    const result = { caseFile: path.resolve(caseFile), caseName: c.name || (c.historicalCopiedCompleted ? 'RAM · исходный ответ' : 'RAM · исправленный ответ'), tabId, sessionId: c.sessionId, turnId: c.turnId,
      rpcCount, model: review.reviewMeta?.model, thinking: instruction.thinkingLevel,
      instructionSHA: sha(instruction.text), promptSHA: sha(request), answerSHA: sha(proof.final.text),
      reviewSHA: sha(review.text), nativeProof: path.join(folder, 'NATIVE-PROOF.json'), archive: archiveFile,
      requestCount: 1 + additionalInputs.length,
      root: c.root, apiReceivedAndReturned: true, automaticSends: 0,
      historicalCopiedCompleted: !!c.historicalCopiedCompleted, providerRunInThisTrial: !c.historicalCopiedCompleted };
    await save(path.join(folder, 'RESULT.json'), result);
    console.log('[MiniArchivedReview] completed rpc=' + rpcCount + ' readOnly=true result=' + folder);
  } finally { core.dispose(); }
}
if (require.main === module) main().catch(error => { console.error('[MiniArchivedReview] ' + error.message); process.exitCode = 1; });
module.exports = { boundedJson };
