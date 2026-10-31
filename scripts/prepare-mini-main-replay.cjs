'use strict';
// Offline preparation from selected PUBLIC API evidence and ordinary linked
// policy files. Never reads provider storage or starts an app/model/MCP run.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveMiniOrchestratorInstruction } = require('../src/main/mini-orchestrator-runtime');
const { buildMiniReviewObject, MINI_REVIEW_SEND_TOOL } = require('../src/main/mini-orchestrator-gemini');
const dir = path.resolve(__dirname, '../docs/tmp/мини-оркестратор-20261030/replay/main');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
async function frozen(name, value) {
  const file = path.join(dir, name);
  try { await fs.writeFile(file, value, { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!Buffer.from(value).equals(await fs.readFile(file))) throw Error('frozen_artifact_changed:' + name);
  }
}
async function main() {
  const source = JSON.parse(await fs.readFile(path.join(dir, 'SOURCE-EVIDENCE.json'), 'utf8'));
  const { canonical, receipt, latestCompact, selectedCompact, systemPrompt } = source;
  if (!canonical.complete || canonical.truncatedBefore || canonical.truncatedAfter
    || canonical.ref.textHash !== sha(canonical.text)
    || canonical.ref.userUuid !== receipt.entryUuid || canonical.ref.sessionId !== receipt.sessionId
    || !receipt.exactAuditConfirmed || receipt.state !== 'confirmed') throw Error('exact_user_evidence_required');
  if (canonical.ref.userUuid !== 'codex-user-dcb48f49-d127-49d7-82f4-a97370d3d114-69060'
    || latestCompact.kind !== 'compact_summary' || selectedCompact?.kind !== 'compact_summary'
    || !(Date.parse(selectedCompact.timestamp) < Date.parse(canonical.timestamp))
    || !(Date.parse(latestCompact.timestamp) > Date.parse(canonical.timestamp))) throw Error('compact_boundary_evidence_changed');
  const prior = await fs.readFile(path.join(dir, 'REPLAY.json'), 'utf8').then(JSON.parse)
    .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (prior?.clonePrepared || prior?.targetTabId || prior?.targetSessionId) throw Error('prepared_target_must_not_be_replaced');
  const settings = { model: systemPrompt.model, thinkingLevel: systemPrompt.thinkingLevel };
  const resolved = await resolveMiniOrchestratorInstruction({ prompt: systemPrompt, settings, includeFileMetadata: true });
  const digest = sha(resolved.text), stem = 'INSTRUCTIONS-' + digest.slice(0, 12);
  const object = buildMiniReviewObject({
    owner: { provider: 'codex', sessionId: '<ACTUAL_PRIVATE_WRITER_SID>', generation: '<ACTUAL_PRIVATE_LIFECYCLE>' },
    turnId: '<ACTUAL_PRIVATE_TURN_ID>', jobId: '<ACTUAL_MINI_JOB_ID>',
    inputs: [{ inputId: '<ACTUAL_CANONICAL_TEST_USER_UUID>', text: canonical.text }],
    answer: '<ANSWER_AFTER_FEDOR_MANUAL_SEND>' });
  const metadata = { promptId: systemPrompt.id, sourcePromptRevision: systemPrompt.revision,
    resolvedRevision: resolved.revision, sha256: digest, chars: resolved.text.length,
    ...settings, linkedFiles: resolved.linkedFiles, selectionOrigin: 'SystemPrompt default; test-tab-not-created',
    providerReceived: false, runtimeRequestAudit: null };
  const fence = '`'.repeat(Math.max(4, ...[...resolved.text.matchAll(/`+/g)].map(match => match[0].length + 1)));
  await frozen('REPLAY-PROMPT.txt', canonical.text); // exact UTF16 body, NO newline
  await frozen('EDITOR-PROMPT.txt', receipt.authoringSnapshot.editorText);
  await frozen('REPLAY-AUTHORING.json', json({ ...receipt.authoringSnapshot,
    contextUpdate: { source: 'canonical saved_prompt wrapper', alreadyExpandedIn: 'REPLAY-PROMPT.txt' },
    canonicalUserUuid: canonical.ref.userUuid, handoffId: receipt.handoffId,
    imageRequestProjection: receipt.imageRequestProjection }));
  await frozen('SYSTEM-PROMPT.json', json(systemPrompt));
  await frozen(stem + '.txt', resolved.text);
  await frozen(stem + '.template.json', json({ systemInstructionSource: stem + '.txt', userObject: object,
    tools: [MINI_REVIEW_SEND_TOOL], ...settings, maxOutputTokens: 8192,
    generationAttempted: false, runtimeRequestAudit: null,
    attachmentContract: 'Current Gemini adapter sends JSON text, not image bytes; source Image #1 must still accompany the main-model replay. No hidden prior-context expansion.' }));
  await frozen(stem + '.md', '# Main/Rewind — инструкция Mini до запуска\n\n'
    + 'Это сборка тем же resolver, что runtime, из API-defined SystemPrompt и текущих live linked files. Старые frozen snapshots не переписаны. Test tab/SID не созданы; настройки — defaults, не observed override и не provider receipt.\n\n'
    + '```json\n' + json(metadata) + '```\n\n## Полный resolved текст\n\n' + fence + 'text\n' + resolved.text + '\n' + fence + '\n\n'
    + 'Шаблон передачи: [' + stem + '.template.json](./' + stem + '.template.json). Actual app-owned IDs будут известны только при реальном ходе. '
    + 'В шаблоне нет предыдущего ответа/позднего уточнения20:15 или посторонней MCP-итерации. Текущий Gemini adapter передаёт JSON-текст, не screenshot bytes. '
    + 'Runtime audit отсутствует: приложение и provider не запускались.\n');
  const manifest = { version: 1, case: 'Main/Rewind', status: 'blocked',
    sourceTabId: source.tabId, sourceSessionId: source.sessionId, selectedUser: canonical.ref,
    selectedTimestamp: canonical.timestamp, handoffId: receipt.handoffId,
    requestedBoundary: source.requestedBoundary, requestedFork: source.requestedFork,
    latestCompact, selectedCompact, reason: source.boundaryFinding,
    targetTabId: null, targetSessionId: null, clonePrepared: false,
    prompt: { file: 'REPLAY-PROMPT.txt', chars: canonical.text.length, sha256: sha(canonical.text), images: receipt.expectedImageRefs },
    instruction: { ...metadata, file: stem + '.md', textFile: stem + '.txt', templateFile: stem + '.template.json' },
    mutations: { source: 0, forks: 0, rewinds: 0, appDevLaunches: 0, modelPrompts: 0 },
    privateTransfer: { available: false, publicMechanism: null } };
  // A new instruction version changes the pointer only, never old snapshots or
  // a prepared profile. A different historical target needs separate evidence.
  if (prior && prior.selectedUser.userUuid !== canonical.ref.userUuid) throw Error('different_selected_target');
  await fs.writeFile(path.join(dir, 'REPLAY.json'), json(manifest), { mode: 0o600 });
  console.log('[MiniReplay] ' + json({ case: manifest.case, promptChars: canonical.text.length,
    images: receipt.expectedImageRefs.length, instructionChars: resolved.text.length, instructionSHA: digest,
    status: manifest.status, reason: manifest.reason.code, targetTabId: null, providerReceived: false }).trim());
}
main().catch(error => { console.error('[MiniReplay] ' + error.message); process.exitCode = 1; });
