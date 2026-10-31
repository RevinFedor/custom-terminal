'use strict';
// Consumes ONLY API-derived task evidence and linked ordinary instruction
// documents. No provider session files, DB, app, CLI model or MCP invocation.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveMiniOrchestratorInstruction } = require('../src/main/mini-orchestrator-runtime');
const { buildMiniReviewObject, MINI_REVIEW_SEND_TOOL } = require('../src/main/mini-orchestrator-gemini');
const folder = path.resolve(__dirname, '../docs/tmp/мини-оркестратор-20261030/replay');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const replayObject = source => buildMiniReviewObject({ owner: { provider: 'codex', sessionId: '<ACTUAL_PRIVATE_WRITER_SID>', generation: '<ACTUAL_PRIVATE_LIFECYCLE>' },
  turnId: '<ACTUAL_PRIVATE_TURN_ID>', jobId: '<ACTUAL_MINI_JOB_ID>',
  inputs: [{ inputId: '<ACTUAL_CANONICAL_TEST_USER_UUID>', text: source.canonical.text }], answer: '<ANSWER_AFTER_FEDOR_MANUAL_SEND>' });
async function main() {
  const instructionVersionOnly = process.argv.includes('--instruction-version');
  const existing = await fs.readFile(path.join(folder, 'REPLAY.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!instructionVersionOnly && (existing?.clonePrepared || existing?.targetTabId || existing?.targetSessionId)) throw Error('existing_prepared_target_must_not_be_replaced');
  const source = JSON.parse(await fs.readFile(path.join(folder, 'SOURCE-EVIDENCE.json'), 'utf8'));
  if (!source.canonical.complete || source.canonical.text !== source.receipt.promptText) throw Error('exact_prompt_evidence_mismatch');
  if (sha(source.canonical.text) !== source.canonical.ref.textHash) throw Error('canonical_text_hash_mismatch');
  if (source.receipt.expectedImagePaths.length || source.receipt.authoringSnapshot.imagePaths.length) throw Error('attachments_require_explicit_preparation');
  const prompt = source.systemPrompt;
  const settings = { model: prompt.model, thinkingLevel: prompt.thinkingLevel };
  const resolved = await resolveMiniOrchestratorInstruction({ prompt, settings, includeFileMetadata: true });
  if (instructionVersionOnly) {
    const digest = sha(resolved.text), stem = 'INSTRUCTIONS-' + digest.slice(0, 12);
    const metadata = { version: 1, sourcePromptRevision: prompt.revision, resolvedRevision: resolved.revision,
      sha256: digest, chars: resolved.text.length, model: settings.model, thinkingLevel: settings.thinkingLevel,
      linkedFiles: resolved.linkedFiles, providerReceived: false, runtimeRequestAudit: null, clonePrepared: false };
    const fence = '`'.repeat(Math.max(4, ...[...resolved.text.matchAll(/`+/g)].map(match => match[0].length + 1)));
    const text = '# Mini — новая версия инструкции до запуска\n\n'
      + 'Старые frozen snapshots НЕ переписаны. Canonical linked policy обновлена parent; ниже копия фактической новой сборки тем же runtime resolver, не изменение политики исполнителем.\n\n'
      + JSON.stringify(metadata, null, 2) + '\n\n## Полный resolved текст\n\n' + fence + 'text\n' + resolved.text + '\n' + fence + '\n\n'
      + 'Шаблон user object/tool остаётся в REVIEWER-INPUT-TEMPLATE.json. Test tab/SID не созданы; модель/thinking — planned SystemPrompt default, не observed per-tab override. Provider audit NOTRUN.\n';
    try { await fs.writeFile(path.join(folder, stem + '.md'), text, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    for (const [name, body] of [[stem + '.txt', resolved.text], [stem + '.template.json', JSON.stringify({ systemInstructionSource: stem + '.txt',
      userObject: replayObject(source), tools: [MINI_REVIEW_SEND_TOOL], model: settings.model, thinkingLevel: settings.thinkingLevel,
      maxOutputTokens: 8192, generationAttempted: false, runtimeRequestAudit: null }, null, 2) + '\n']]) {
      try { await fs.writeFile(path.join(folder, name), body, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    await fs.writeFile(path.join(folder, 'CURRENT-INSTRUCTIONS.json'), JSON.stringify({ ...metadata, file: stem + '.md',
      textFile: stem + '.txt', templateFile: stem + '.template.json' }, null, 2) + '\n', { mode: 0o600 });
    console.log('[MiniReplay] instruction-version ' + JSON.stringify({ file: stem + '.md', chars: resolved.text.length, sha256: digest, frozenOverwrites: 0, providerReceived: false })); return;
  }
  if (existing && (existing.prompt.sha256 !== sha(source.canonical.text) || existing.instruction.sha256 !== sha(resolved.text)))
    throw Error('frozen_preparation_changed_create_a_separate_version_instead');
  if (existing) {
    const retained = ['REPLAY-PROMPT.txt', 'REPLAY-AUTHORING.json', 'SYSTEM-PROMPT.json', 'REVIEWER-RESOLVED.txt', 'REVIEWER-INPUT-TEMPLATE.json', 'INSTRUCTIONS-SNAPSHOT.md', 'CONTEXT-REFERENCE.md'];
    await Promise.all(retained.map(name => fs.access(path.join(folder, name))));
    if (sha(await fs.readFile(path.join(folder, 'REPLAY-PROMPT.txt'))) !== existing.prompt.sha256
      || sha(await fs.readFile(path.join(folder, 'REVIEWER-RESOLVED.txt'))) !== existing.instruction.sha256)
      throw Error('frozen_artifact_changed_not_overwritten');
    console.log('[MiniReplay] existing frozen preparation retained; no artifact overwritten'); return;
  }
  const files = await Promise.all(prompt.filePaths.map(async file => { const bytes = await fs.readFile(file); return { path: file, bytes: bytes.length, sha256: sha(bytes) }; }));
  const object = replayObject(source);
  const definition = Object.fromEntries(['id', 'name', 'content', 'model', 'thinkingLevel', 'color', 'showInContextMenu', 'position', 'filePaths', 'revision'].map(key => [key, prompt[key]]));
  const save = (name, text) => fs.writeFile(path.join(folder, name), text, { mode: 0o600 });
  await save('REPLAY-PROMPT.txt', source.canonical.text); // intentionally NO added newline
  await save('REPLAY-AUTHORING.json', JSON.stringify(source.receipt.authoringSnapshot, null, 2) + '\n');
  await save('SYSTEM-PROMPT.json', JSON.stringify(definition, null, 2) + '\n');
  await save('REVIEWER-RESOLVED.txt', resolved.text);
  await save('REVIEWER-INPUT-TEMPLATE.json', JSON.stringify({ systemInstructionSource: 'REVIEWER-RESOLVED.txt',
    userObject: object, tools: [MINI_REVIEW_SEND_TOOL], model: settings.model, thinkingLevel: settings.thinkingLevel,
    maxOutputTokens: 8192, generationAttempted: false, runtimeRequestAudit: null }, null, 2) + '\n');
  const manifest = { version: 1, status: 'blocked', sourceTabId: source.tabId, sourceSessionId: source.sessionId,
    selectedUser: source.canonical.ref, selectedLocalMessageId: source.localMessageId, handoffId: source.handoffId,
    requestedBoundary: 'before-selected-user-iteration', targetTabId: null, targetSessionId: null, clonePrepared: false,
    reason: source.cloneRefusal, ownerConfirmation: source.ownerConfirmation,
    prompt: { file: 'REPLAY-PROMPT.txt', chars: source.canonical.text.length, sha256: sha(source.canonical.text), chips: source.receipt.authoringSnapshot.chips.length, images: 0 },
    instruction: { file: 'REVIEWER-RESOLVED.txt', sha256: sha(resolved.text), chars: resolved.text.length,
      revision: resolved.revision, model: settings.model, thinkingLevel: settings.thinkingLevel,
      selectionOrigin: 'source-SystemPrompt-default; test-tab-not-created', linkedFiles: files, providerReceived: false },
    sourceMutations: 0, appLaunches: 0, providerGenerations: 0, createdAt: new Date().toISOString() };
  await save('REPLAY.json', JSON.stringify(manifest, null, 2) + '\n');
  const fence = '`'.repeat(Math.max(4, ...[...resolved.text.matchAll(/`+/g)].map(match => match[0].length + 1)));
  const md = '# Mini replay — снимок инструкции до запуска\n\n'
    + 'Это подготовленный Source snapshot, не квитанция отправки провайдеру. Test tab/SID ещё не созданы: no-start Codex clone API отсутствует.\n\n'
    + `SystemPrompt: ${prompt.id}; source revision ${prompt.revision}. Planned default: ${settings.model} / ${settings.thinkingLevel}. Per-tab runtime override пока не существует.\n\n`
    + `Resolved SHA256: ${sha(resolved.text)}. Сборка — той же resolveMiniOrchestratorInstruction, что runtime.\n\n`
    + 'Seeder теперь копирует public SystemPrompt definition вместе с собственным content. Ранний basic seeder оставлял content пустым; это расхождение явно исправлено, файл инструкции не менялся.\n\n'
    + 'Связанные файлы:\n\n' + files.map(file => `- ${file.path} — ${file.bytes} bytes, SHA256 ${file.sha256}`).join('\n')
    + '\n\n## Полный resolved system text\n\n' + fence + 'text\n' + resolved.text + '\n' + fence + '\n\n'
    + '## Передача request/answer\n\nПолная форма и ограниченный tool — в REVIEWER-INPUT-TEMPLATE.json. Метки ACTUAL — placeholders, не выдуманные runtime IDs. '
    + 'По текущему producer request содержит новый захваченный запрос №2; прошлые Q1/A1 сами по себе в payload reviewer не перечитываются. Они должны оставаться в контексте основной копии. '
    + 'Этот snapshot не добавляет Q1/A1 в Gemini скрытно и не изменяет инструкцию ради результата.\n\n'
    + 'Runtime request audit: NOTRUN / отсутствует. После запуска изменение picker отражается в runtime metadata, но не делает этот prelaunch snapshot подтверждением отправки.\n';
  await save('INSTRUCTIONS-SNAPSHOT.md', md);
  await save('CONTEXT-REFERENCE.md', '# Контекст перед выбранным запросом — только справка\n\n'
    + 'Получено штатными targeted API после проверки canonical chronology. Это НЕ переносимый Codex snapshot и НЕ замена независимой копии. '
    + 'Предыдущая итерация6/user704 идёт перед выбранной7/user794; номера получены API, не использовались как догадка для rewrite.\n\n'
    + '## Предыдущий запрос\n\n' + source.previous.user.text + '\n\n## Предыдущий ответ, последний assistant block\n\n'
    + source.previous.assistant.text + '\n\n'
    + 'Для точного native replay в копии должен оставаться ВЕСЬ доказанный prefix до выбранного запроса, не только эти два текста. '
    + 'Никакие команды/HH действия из истории подготовка не повторяла.\n');
  console.log('[MiniReplay] evidence-prepared ' + JSON.stringify({ promptChars: manifest.prompt.chars, chipCount: manifest.prompt.chips,
    instructionChars: resolved.text.length, status: manifest.status, targetTabId: null, providerGenerations: 0 }));
}
main().catch(error => { console.error('[MiniReplay] preparation failed: ' + error.message); process.exitCode = 1; });
