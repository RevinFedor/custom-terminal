'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMiniOrchestratorRuntime, resolveMiniOrchestratorInstruction } = require('./mini-orchestrator-runtime');
const owner = { provider: 'codex', sessionId: 'own-source', generation: 'own-lifecycle:1' };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ correction = false, automaticCorrections } = {}) {
  const store = new Map(), calls = [], sends = [], published = [], state = { owner, turnId: 'own-turn', ready: false };
  const runtime = createMiniOrchestratorRuntime({ db: {
    getAppState: key => store.get(key), setAppState: (key, value) => store.set(key, value),
  }, systemPromptService: { get: id => ({ id, name: 'Own instruction', revision: 'r1', model: 'gemini-3.8-flash', thinkingLevel: 'HIGH', content: 'Review only the object', filePaths: [] }) },
  automaticCorrections, readOwner: () => state, publish: (_tabId, snapshot) => published.push(snapshot),
  review: async input => { calls.push(input); if (correction) await input.onSendPrompt('Supply the missing second number.'); return { text: correction ? 'Есть конкретный недочёт.' : 'Запрос выполнен.' }; },
  sendCorrection: async request => { sends.push(request); return { status: 'queued', handoffId: request.handoffId }; },
  });
  const feed = (payload, extra = {}) => runtime.capture.observeCodex({ tabId: 'own-tab', owner,
    record: { type: 'event_msg', payload }, sourceVerified: true, turnId: 'own-turn',
    inputId: 'own-input', inputText: 'Give two numbers', recordId: 'own-final', ...extra });
  return { runtime, store, calls, sends, published, state, feed };
}
test('live exact pair uses no reader; defaultOff and duplicate completion do not call Gemini', async () => {
  const f = fixture(); f.feed({ type: 'task_started' }); f.feed({ type: 'user_message' });
  f.feed({ type: 'task_complete', last_agent_message: '1, 2' }, { completionProven: true }); await tick();
  assert.equal(f.calls.length, 0);
  f.runtime.setEnabled('own-tab', true);
  f.feed({ type: 'task_started' }); f.feed({ type: 'user_message' });
  f.state.ready = true; f.feed({ type: 'task_complete', last_agent_message: '1, 2' }, { completionProven: true }); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].inputs[0].inputId, 'own-input'); assert.equal(f.calls[0].answer, '1, 2');
  f.feed({ type: 'task_complete', last_agent_message: '1, 2' }, { completionProven: true }); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.sends.length, 0); f.runtime.dispose();
});
test('queued correction keeps HEAD/writer guard but a newer accepted app input immediately revokes it', async () => {
  const f = fixture({ correction: true }); f.runtime.setEnabled('own-tab', true);
  f.feed({ type: 'task_started' }); f.feed({ type: 'user_message' }); f.state.ready = true;
  f.feed({ type: 'task_complete', last_agent_message: '1' }, { completionProven: true }); await tick();
  assert.equal(f.sends.length, 1); const request = f.sends[0];
  assert.equal(f.runtime.guard(request), null);
  f.runtime.onInputAccepted({ tabId: 'own-tab', handoffId: request.handoffId, operationKey: 'own-review-op' });
  assert.equal(f.runtime.guard(request), null, 'own queued correction is not a new external input');
  f.runtime.onInputAccepted({ tabId: 'own-tab', handoffId: 'new-real-user', operationKey: 'new-user-op' });
  assert.equal(f.runtime.guard(request).code, 'mini_orchestrator_review_stale');
  f.runtime.onReceipt({ tabId: 'own-tab', handoffId: request.handoffId, operationKey: 'own-review-op', state: 'confirmed', receipt: { submitted: true } });
  assert.equal(f.runtime.get('own-tab').entries.find(x => x.type === 'tool').receipt.status, 'sent');
  f.runtime.dispose();
});
test('new queued input blocks old completion until its own exact canonical audit, without a full History read', async () => {
  const f = fixture(); f.runtime.setEnabled('own-tab', true);
  f.feed({ type: 'task_started' }); f.feed({ type: 'user_message' }); f.state.ready = true;
  f.runtime.onInputAccepted({ tabId: 'own-tab', handoffId: 'waiting-new-request', operationKey: 'new-op' });
  f.feed({ type: 'task_complete', last_agent_message: '1, 2' }, { completionProven: true }); await tick(); assert.equal(f.calls.length, 0);
  f.runtime.capture.flush('own-tab'); await tick(); assert.equal(f.calls.length, 0);
  f.runtime.dispose();
});

test('per-tab model selection is durable, revisioned, and never mutates another tab or the system prompt', () => {
  const f = fixture();
  const before = f.runtime.get('own-tab');
  f.runtime.setSettings('own-tab', { model: 'gemini-3.5-flash-lite', thinkingLevel: 'LOW', expectedRevision: before.settings.revision });
  const after = f.runtime.get('own-tab');
  assert.equal(after.settings.model, 'gemini-3.5-flash-lite');
  assert.equal(after.settings.thinkingLevel, 'LOW');
  assert.ok(after.viewRevision > before.viewRevision);
  assert.equal(f.runtime.get('other-tab').settings.model, 'gemini-3.8-flash');
  assert.equal(f.store.get('mini-orchestrator-settings:own-tab').model, 'gemini-3.5-flash-lite');
  assert.throws(() => f.runtime.setSettings('own-tab', { model: 'gemini-3.8-flash', thinkingLevel: 'HIGH', expectedRevision: before.settings.revision }), /mini_settings_changed/);
  assert.throws(() => f.runtime.setSettings('own-tab', { model: '../foreign', thinkingLevel: 'HIGH', expectedRevision: after.settings.revision }), /mini_settings_invalid/);
  f.runtime.dispose();
});

test('model and effort are pinned for the request, blocked while running, and retained on the completed review', async () => {
  let resolveReview;
  const f = fixture();
  const request = new Promise(resolve => { resolveReview = resolve; });
  // A separate actual runtime with a controlled long provider request.
  const store = new Map(), calls = [], state = { owner, turnId: 'own-turn', ready: true };
  const runtime = createMiniOrchestratorRuntime({ db: { getAppState: k => store.get(k), setAppState: (k, v) => store.set(k, v) },
    systemPromptService: { get: id => ({ id, name: 'Own', revision: 'r1', model: 'gemini-3.8-flash', thinkingLevel: 'HIGH', content: 'Own', filePaths: [] }) },
    readOwner: () => state, review: input => { calls.push(input); return request; }, sendCorrection: async () => assert.fail('no send') });
  runtime.setEnabled('own-tab', true);
  const feed = payload => runtime.capture.observeCodex({ tabId: 'own-tab', owner, record: { type: 'event_msg', payload },
    sourceVerified: true, turnId: 'own-turn', inputId: 'own-i', inputText: 'Own question', recordId: 'own-f', completionProven: true });
  feed({ type: 'task_started' }); feed({ type: 'user_message' }); feed({ type: 'task_complete', last_agent_message: 'Own answer' }); await tick();
  const running = runtime.get('own-tab'); assert.equal(running.phase, 'reviewing');
  assert.equal(running.activeReview.model, 'gemini-3.8-flash');
  assert.throws(() => runtime.setSettings('own-tab', { model: 'gemini-3.5-flash-lite', thinkingLevel: 'LOW', expectedRevision: running.settings.revision }), /mini_settings_busy/);
  resolveReview({ text: 'Own review', actualModel: 'gemini-3.8-flash-002' }); await tick();
  const completed = runtime.get('own-tab'), meta = completed.entries.find(entry => entry.type === 'review').reviewMeta;
  assert.equal(meta.model, 'gemini-3.8-flash-002'); assert.equal(meta.thinkingLevel, 'HIGH'); assert.ok(meta.durationMs >= 0);
  runtime.setSettings('own-tab', { model: 'gemini-3.5-flash-lite', thinkingLevel: 'LOW', expectedRevision: completed.settings.revision });
  assert.equal(runtime.get('own-tab').entries.find(entry => entry.type === 'review').reviewMeta.model, meta.model);
  assert.equal(calls.length, 1); runtime.dispose(); f.runtime.dispose();
});

test('unknown preference save retains the intent and blocks generation until an explicit successful save', () => {
  let fail = true; const store = new Map();
  const runtime = createMiniOrchestratorRuntime({ db: { getAppState: key => store.get(key), setAppState: (key, value) => { if (fail) throw Error('own I/O failure'); store.set(key, value); } },
    systemPromptService: { get: id => ({ id, revision: 'r1', model: 'gemini-3.8-flash', thinkingLevel: 'HIGH', filePaths: [] }) }, readOwner: () => null,
    review: async () => assert.fail('must not generate'), sendCorrection: async () => assert.fail('must not send') });
  let current = runtime.get('t');
  assert.throws(() => runtime.setSettings('t', { model: 'gemini-3.5-flash-lite', thinkingLevel: 'LOW', expectedRevision: current.settings.revision }), /mini_settings_unconfirmed/);
  current = runtime.get('t'); assert.equal(current.settings.model, 'gemini-3.5-flash-lite'); assert.equal(current.settings.error, 'mini_settings_unconfirmed');
  fail = false;
  runtime.setSettings('t', { model: current.settings.model, thinkingLevel: 'LOW', expectedRevision: current.settings.revision });
  assert.equal(runtime.get('t').settings.error, undefined); runtime.dispose();
  const restored = createMiniOrchestratorRuntime({ db: { getAppState: key => store.get(key), setAppState: (key, value) => store.set(key, value) },
    systemPromptService: { get: id => ({ id, revision: 'r1', model: 'gemini-3.8-flash', thinkingLevel: 'HIGH', filePaths: [] }) }, readOwner: () => null });
  assert.equal(restored.get('t').settings.model, 'gemini-3.5-flash-lite'); assert.equal(restored.get('t').enabled, false); restored.dispose();
});

test('resolved automatic format is part of actual system text and revision; default text and shape stay byte-exact', async () => {
  const { createHash } = require('node:crypto');
  const prompt = { id: 'own-prompt', name: 'Own', revision: 'r1', content: 'Original read-only instruction.', filePaths: [], automaticCorrections: true };
  const settings = { model: 'gemini-3.8-flash', thinkingLevel: 'HIGH', automaticCorrections: true };
  const baseline = await resolveMiniOrchestratorInstruction({ prompt, settings });
  const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 12);
  assert.equal(baseline.text, prompt.content); assert.equal(baseline.revision, 'r1:' + hash(prompt.content));
  assert.equal(Object.hasOwn(baseline, 'automaticCorrections'), false);
  for (const value of [false, 'true', 1, undefined]) {
    const resolved = await resolveMiniOrchestratorInstruction({ prompt, settings, automaticCorrections: value });
    assert.deepEqual(resolved, baseline, 'untrusted prompt/settings fields or truthy values cannot enable mode');
  }
  const auto = await resolveMiniOrchestratorInstruction({ prompt, settings, automaticCorrections: true, includeFileMetadata: true });
  assert.ok(auto.text.startsWith(baseline.text + '\n\n'));
  assert.match(auto.text, /finish_review/); assert.match(auto.text, /NOT an MCP tool/);
  assert.match(auto.text, /application may separately forward at most one correction/);
  assert.match(auto.text, /no execution tools or direct sending authority/);
  assert.equal(auto.automaticCorrections, true); assert.equal(auto.revision, 'r1:' + hash(auto.text));
  assert.notEqual(auto.revision, baseline.revision); assert.deepEqual(auto.linkedFiles, []);
});
test('runtime opt-in publishes autoReturn and the exact formatted instruction; ordinary settings cannot opt in', async () => {
  for (const option of [undefined, false, 'true', true]) {
    const f = fixture({ automaticCorrections: option });
    f.store.set('mini-orchestrator-settings:own-tab', { revision: 0, autoReturn: true, automaticCorrections: true });
    f.runtime.setEnabled('own-tab', true);
    f.feed({ type: 'task_started' }); f.feed({ type: 'user_message' }); f.state.ready = true;
    f.feed({ type: 'task_complete', last_agent_message: '1, 2' }, { completionProven: true }); await tick();
    assert.equal(f.calls.length, 1); assert.equal(f.sends.length, 0);
    const automatic = option === true, snapshot = f.runtime.get('own-tab'), instruction = f.calls[0].instruction;
    assert.equal(snapshot.autoReturn, automatic ? true : undefined);
    assert.equal(instruction.automaticCorrections, automatic ? true : undefined);
    assert.equal(f.published.at(-1).autoReturn, automatic ? true : undefined);
    if (automatic) assert.match(instruction.text, /finish_review/); else assert.equal(instruction.text, 'Review only the object');
    const shown = snapshot.entries.find(e => e.type === 'instruction');
    assert.equal(shown.text, instruction.text, 'UI/audit display the actual system instruction, not a hidden append');
    assert.equal(shown.promptRevision, instruction.revision);
    f.runtime.dispose();
  }
});
test('automatic snapshot flag is also trusted and explicit when prompt settings cannot be loaded', () => {
  for (const automaticCorrections of [false, true]) {
    const runtime = createMiniOrchestratorRuntime({ automaticCorrections,
      db: { getAppState: () => null, setAppState() {} }, systemPromptService: { get: () => null }, readOwner: () => null,
      review: async () => assert.fail('no review'), sendCorrection: async () => assert.fail('no send') });
    const snapshot = runtime.get('own-tab');
    assert.equal(snapshot.autoReturn, automaticCorrections ? true : undefined);
    assert.equal(snapshot.settings.error, 'mini_reviewer_prompt_required');
    runtime.dispose();
  }
});
