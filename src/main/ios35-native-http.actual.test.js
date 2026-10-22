'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const http = require('node:http');
const { createIos35NativeFixture } = require('./fixtures/ios35-native-http.cjs');
async function fixture(t, options) {
  const h = await createIos35NativeFixture({ ttlMs: 10000, ...options }); t.after(h.close);
  const call = async (route, body, { auth = true, method = body ? 'POST' : 'GET' } = {}) => {
    const response = await fetch(h.baseUrl + route, { method, headers: {
      ...(auth ? { authorization: 'Bearer ' + h.token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { ...h, call, command: action => call('/__fixture/control', { action }) };
}
const basis = catalog => ({ sourceEpoch: catalog.sourceEpoch, catalogClock: catalog.catalogClock });
const controlsOnly = 'private-controls: ';
const saveControlWire = (name, value) => {
  if (!process.env.IOS35_CONTROL_WIRE_DIR) return;
  fs.mkdirSync(process.env.IOS35_CONTROL_WIRE_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.IOS35_CONTROL_WIRE_DIR, name + '.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
};
test('private native file preview materializes an indexed file outside first5 without paging', async t => {
  const h = await fixture(t), before = (await h.call('/api/workflow-organization?projection=catalog-v2')).body;
  const result = await h.call('/api/tab-catalog/ios35-file-26/file-preview', { ...basis(before), workflowId: 'main' });
  assert.equal(result.status, 200);
  assert.match(JSON.stringify(result.body), /PRIVATE IOS35 FILE 26/);
  assert.equal(h.status().counts.filePage, 0);
  assert.deepEqual((await h.call('/api/workflow-organization?projection=catalog-v2')).body, before);
  assert.equal(h.status().history.inputEffects, 0); assert.equal(h.status().providerCalls, 0);
});
function rawHistory(t, h) {
  const state = { headers: false, bodyChunks: 0 };
  const promise = new Promise((resolve, reject) => {
    state.request = http.get(h.baseUrl + '/api/terminal-tabs/' + h.tabId + '/history?view=history&delta=1&last=80',
      { headers: { authorization: 'Bearer ' + h.token } }, res => {
        state.headers = true; let body = '';
        res.on('data', chunk => { state.bodyChunks++; body += chunk; });
        res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
    state.request.on('error', reject);
  });
  promise.catch(() => {}); t.after(() => state.request.destroy());
  return { state, promise };
}

test(controlsOnly + 'runtime unknown/known-zero/positive revalidation uses the same actual catalog and owner scope', async t => {
  const h = await fixture(t), catalog = (await h.call('/api/workflow-organization?projection=catalog-v2')).body;
  const request = { ...basis(catalog), tabIds: [h.tabId] };
  const read = async () => { const r = await h.call('/api/workflow-organization/runtime-summary', request); assert.equal(r.status, 200); return r.body; };
  const positive = await read(), p = positive.tabs[0], workflow = value => value.workflows.find(w => w.workflowId === 'main');
  assert.equal(workflow(positive).liveCount, 1); assert.equal(workflow(positive).busyCount, 1);
  assert.equal((await h.command('runtime-unknown')).status, 200);
  const unknown = await read(), u = unknown.tabs[0];
  assert.equal(workflow(unknown).liveKnown, false); assert.equal(workflow(unknown).liveCount, null);
  assert.equal(workflow(unknown).busyKnown, false); assert.equal(workflow(unknown).busyCount, null);
  assert.equal(u.live, null); assert.equal(u.ownBusy, null); assert.equal(u.inheritedBusy, null);
  assert.equal(u.ownerToken, null); assert.equal(u.ownerOrder, null); assert.equal(u.proof, 'unproven');
  assert.equal((await h.command('runtime-zero')).status, 200);
  const zero = await read(), z = zero.tabs[0];
  assert.equal(workflow(zero).liveKnown, true); assert.equal(workflow(zero).liveCount, 0);
  assert.equal(workflow(zero).busyKnown, true); assert.equal(workflow(zero).busyCount, 0);
  assert.equal(z.live, false); assert.equal(z.ownBusy, false);
  assert.equal((await h.command('runtime-positive')).status, 200);
  const restored = await read();
  assert.deepEqual(restored.tabs[0], p);
  await h.command('runtime-positive'); const same = await read();
  assert.equal(same.revision, restored.revision, 'same-value revalidation must not invent a runtime revision');
  assert.ok(positive.revision < unknown.revision && unknown.revision < zero.revision && zero.revision < restored.revision);
  for (const value of [unknown, zero, restored, same]) {
    assert.equal(value.sourceEpoch, positive.sourceEpoch); assert.equal(value.catalogClock, positive.catalogClock);
    assert.equal(value.runtimeEpoch, positive.runtimeEpoch); assert.equal(value.producerEpoch, positive.producerEpoch);
    assert.deepEqual(value.coverage, positive.coverage); assert.deepEqual(value.tabs[0].executionRef, p.executionRef);
    assert.equal(value.tabs[0].lifecycleGeneration, p.lifecycleGeneration); assert.equal(value.tabs[0].terminalRunSeq, p.terminalRunSeq);
  }
  assert.equal(z.ownerToken, p.ownerToken); assert.deepEqual(z.ownerOrder, p.ownerOrder);
  assert.deepEqual((await h.call('/api/workflow-organization?projection=catalog-v2')).body, catalog);
  const status = await h.call('/api/terminal-tabs/' + h.tabId + '/status');
  assert.equal(status.body.writerConfirmed, false); assert.equal(status.body.writerUsableForMutation, false);
  assert.equal(status.body.conversationOwner.currentBinding.state, 'unknown');
  assert.equal(h.status().history.inputEffects, 0); assert.equal(h.status().providerCalls, 0);
  for (const [name, value] of Object.entries({ positive, unknown, zero, restored, same })) saveControlWire('runtime-' + name, value);
});

for (const kind of ['runtime', 'cards']) test(controlsOnly + kind + ' one-shot503 then explicit retry keeps the same basis', async t => {
  const h = await fixture(t), catalog = (await h.call('/api/workflow-organization?projection=catalog-v2')).body;
  const request = { ...basis(catalog), tabIds: [h.tabId] }, route = '/api/workflow-organization/' + (kind === 'runtime' ? 'runtime-summary' : 'card-signals');
  const before = await h.call(route, request); assert.equal(before.status, 200);
  assert.equal((await h.command('fail-' + kind + '-once')).status, 200);
  const failed = await h.call(route, request); assert.equal(failed.status, 503);
  const retry = await h.call(route, request); assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, before.body); assert.equal(h.status().failNext[kind], 0);
  assert.equal(h.status().counts[kind + 'Failures'], 1); assert.equal(h.status().history.inputEffects, 0);
  saveControlWire(kind + '-503', failed); saveControlWire(kind + '-retry', retry.body);
});

test(controlsOnly + 'actual History IO hold has an exact pending attempt and no headers/body until release', async t => {
  const h = await fixture(t);
  assert.equal((await h.command('hold-history')).status, 200);
  const pending = rawHistory(t, h); await h.whenRead('historyIo');
  const held = (await h.call('/__fixture/status')).body, active = held.history.active[0];
  assert.equal(held.history.active.length, 1); assert.equal(active.id, 'history-1'); assert.equal(active.phase, 'held');
  assert.equal(active.headersSent, false); assert.equal(active.bodyEnded, false);
  assert.equal(pending.state.headers, false); assert.equal(pending.state.bodyChunks, 0);
  assert.equal(active.readSessionId, held.history.readSessionId);
  assert.equal((await h.call('/api/terminal-tabs/' + h.tabId + '/status')).body.writerConfirmed, false);
  assert.equal((await h.command('release-history')).status, 200);
  const result = await pending.promise; assert.equal(result.status, 200);
  assert.equal(result.body.readSessionId, active.readSessionId); assert.equal(result.body.writerConfirmed, false);
  assert.match(JSON.stringify(result.body.entries), /PRIVATE IOS35 HISTORY TEXT/);
  const settled = (await h.call('/__fixture/status')).body;
  assert.equal(settled.history.active.length, 0); assert.equal(settled.history.last.id, active.id);
  assert.equal(settled.history.last.statusCode, 200); assert.equal(settled.history.last.bodyEnded, true);
  assert.equal(settled.counts.historyIo, 1); assert.equal(settled.counts.historyCompleted, 1);
  assert.equal(settled.history.inputEffects, 0);
  saveControlWire('history-held', held); saveControlWire('history-released', { result, status: settled });
});

test(controlsOnly + 'owner lost during held History passes actual late recheck409, never stale rows', async t => {
  const h = await fixture(t); await h.command('hold-history');
  const pending = rawHistory(t, h); await h.whenRead('historyIo');
  const active = h.status().history.active[0], sid = active.readSessionId;
  await h.command('history-unknown');
  assert.equal(pending.state.headers, false); assert.equal(pending.state.bodyChunks, 0);
  assert.equal(h.status().history.readSessionId, null); assert.equal(h.status().history.active[0].id, active.id);
  await h.command('release-history'); const result = await pending.promise;
  assert.equal(result.status, 409); assert.equal(result.body.error, 'history_read_identity_changed');
  assert.equal(result.body.previousReadSessionId, sid); assert.equal(result.body.readSessionId, null);
  assert.equal(result.body.entries, undefined); assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE IOS35 HISTORY TEXT/);
  assert.equal(h.status().history.last.id, active.id); assert.equal(h.status().history.last.statusCode, 409);
  await h.command('history-valid');
  const restored = await h.call('/api/terminal-tabs/' + h.tabId + '/status');
  assert.equal(restored.body.readSessionId, sid); assert.equal(restored.body.writerConfirmed, false);
  assert.equal(restored.body.writerUsableForMutation, false); assert.equal(restored.body.sendTarget, null);
  assert.equal(restored.body.conversationOwner.currentBinding.state, 'unknown');
  assert.equal(h.status().history.inputEffects, 0);
  saveControlWire('history-late-owner409', result);
});

test(controlsOnly + 'ten duplicate baselines do not advance SQL publication; real workflow rename does', async t => {
  const h = await fixture(t), controller = new AbortController(); t.after(() => controller.abort());
  const catalog = (await h.call('/api/workflow-organization?projection=catalog-v2')).body;
  const request = { ...basis(catalog), tabIds: [h.tabId] }, before = (await h.call('/api/workflow-organization/runtime-summary', request)).body;
  const response = await fetch(h.baseUrl + '/api/events?scope=projects', {
    headers: { authorization: 'Bearer ' + h.token }, signal: controller.signal });
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  const next = async () => { for (;;) {
    const index = buffer.indexOf('\n\n');
    if (index >= 0) { const event = buffer.slice(0, index); buffer = buffer.slice(index + 2);
      if (event.startsWith('data: ')) return JSON.parse(event.slice(6)); }
    else { const chunk = await reader.read(); assert.equal(chunk.done, false); buffer += decoder.decode(chunk.value, { stream: true }); }
  } };
  const initial = await next(); let duplicate;
  for (let i = 1; i <= 10; i++) { assert.equal((await h.command('duplicate-publication')).status, 200); duplicate = await next();
    assert.deepEqual(duplicate.workflowPublication, initial.workflowPublication); assert.equal(duplicate.sequence, initial.sequence + i); }
  assert.deepEqual((await h.call('/api/workflow-organization?projection=catalog-v2')).body, catalog);
  const committed = await h.command('rename-workflow'); assert.equal(committed.status, 200);
  const real = await next(), fresh = (await h.call('/api/workflow-organization?projection=catalog-v2')).body;
  assert.equal(real.sequence, duplicate.sequence + 1); assert.equal(real.workflowPublication.epoch, initial.workflowPublication.epoch);
  assert.equal(real.workflowPublication.generation, initial.workflowPublication.generation + 1);
  assert.equal(real.workflowPublication.revision, initial.workflowPublication.revision + 1);
  assert.deepEqual(real.workflowPublication, fresh.workflowPublication);
  assert.equal(fresh.sourceEpoch, catalog.sourceEpoch); assert.notEqual(fresh.catalogClock, catalog.catalogClock);
  assert.equal(fresh.clocks.organization.generation, catalog.clocks.organization.generation + 1);
  assert.equal(fresh.clocks.organization.revision, catalog.clocks.organization.revision + 1);
  assert.equal((await h.call('/api/workflow-organization/runtime-summary', request)).status, 409);
  const after = (await h.call('/api/workflow-organization/runtime-summary', { ...basis(fresh), tabIds: [h.tabId] })).body;
  assert.deepEqual(after.tabs, before.tabs); assert.deepEqual(after.coverage, before.coverage);
  assert.equal(h.status().counts.realPublication, 1); assert.equal(h.status().counts.duplicatePublication, 10);
  assert.equal(h.status().history.inputEffects, 0);
  saveControlWire('publication-before', initial); saveControlWire('publication-tenth-duplicate', duplicate);
  saveControlWire('publication-real', real); saveControlWire('publication-commit', committed.body.organizationMutation);
  controller.abort(); await reader.cancel().catch(() => {});
});

for (const termination of ['explicit close', 'TTL']) test(controlsOnly + termination + ' releases held IO and removes exact private roots/listener', async t => {
  const h = await fixture(t, termination === 'TTL' ? { ttlMs: 1500 } : {});
  const closed = new Promise(resolve => h.server.once('close', resolve));
  const catalog = (await h.call('/api/workflow-organization?projection=catalog-v2')).body;
  await h.command('hold-runtime'); await h.command('hold-cards');
  const request = { ...basis(catalog), tabIds: [h.tabId] };
  const runtime = h.call('/api/workflow-organization/runtime-summary', request), cards = h.call('/api/workflow-organization/card-signals', request);
  runtime.catch(() => {}); cards.catch(() => {});
  await Promise.all([h.whenRead('runtime'), h.whenRead('cards')]);
  await h.command('hold-history'); const pending = rawHistory(t, h); await h.whenRead('historyIo');
  assert.equal(h.status().history.active[0].phase, 'held'); assert.equal(pending.state.headers, false);
  if (termination === 'explicit close') await h.close(); else { await closed; await h.close(); }
  await pending.promise.catch(() => {});
  await Promise.allSettled([runtime, cards]);
  assert.equal(h.server.listening, false); assert.equal(fs.existsSync(h.root), false); assert.equal(fs.existsSync(h.historyRoot), false);
  assert.deepEqual(h.status().held, []); assert.equal(h.status().history.active.length, 0);
  assert.equal(h.status().counts.historyCompleted, 1); assert.equal(h.status().history.inputEffects, 0);
  await assert.rejects(fetch(h.baseUrl + '/__fixture/status'));
});

test(controlsOnly + 'new controls retain private auth, exact target and no Send', async t => {
  const h = await fixture(t), before = h.status();
  for (const action of ['runtime-unknown','runtime-zero','runtime-positive','hold-history','fail-runtime-once','fail-cards-once','rename-workflow'])
    assert.equal((await h.call('/__fixture/control', { action }, { auth: false })).status, 401);
  assert.deepEqual(h.status(), before);
  assert.equal((await h.call('/api/terminal-tabs/foreign/history?view=history')).status, 404);
  assert.equal((await h.call('/api/terminal-tabs/' + h.tabId + '/send', {})).status, 404);
  assert.equal((await h.call('/api/workflow-organization/mutations', { kind: 'commitWorkspace' })).status, 404);
  assert.equal((await h.command('runtime-fake-ready')).status, 400);
  assert.equal(h.status().history.inputEffects, 0); assert.equal(h.status().providerCalls, 0);
});

test('private actual HTTP emits native wire receipt, 5/20/2 windows, unchanged retry cursor and read-only History', async t => {
  const h = await fixture(t), outputs = {};
  const keep = (name, result) => { assert.equal(result.status, 200, JSON.stringify(result)); outputs[name] = result.body; return result.body; };
  const me = keep('api-me', await h.call('/api/me'));
  assert.equal(me.capabilities.workflowOrganization.catalogV2.version, 2);
  const catalog = keep('catalog-initial', await h.call('/api/workflow-organization?projection=catalog-v2'));
  assert.deepEqual(catalog.workflowPublication, h.status().workflowPublication);
  assert.equal(catalog.workflowPublication.generation, catalog.clocks.organization.generation);
  assert.equal(catalog.workflowPublication.revision, catalog.clocks.organization.revision);
  const window = catalog.fileWindows[0]; assert.equal(window.loaded, 5); assert.equal(window.total, 27);
  const detail = keep('hidden-file-detail', await h.call('/api/tab-catalog/ios35-file-26/detail', { ...basis(catalog), workflowId: 'main' }));
  assert.equal(detail.detail.tabId, 'ios35-file-26');
  await h.command('fail-file-page-once');
  outputs['file-page-unavailable'] = await h.call('/api/workflow-organization/file-page', { cursor: window.nextCursor });
  assert.equal(outputs['file-page-unavailable'].status, 503);
  const page = keep('file-next20', await h.call('/api/workflow-organization/file-page', { cursor: window.nextCursor }));
  assert.equal(page.requestCursor, window.nextCursor); assert.equal(page.nodeIds.length, 20);
  assert.deepEqual((await h.call('/api/workflow-organization/file-page', { cursor: window.nextCursor })).body, page);
  const tail = keep('file-tail2', await h.call('/api/workflow-organization/file-page', { cursor: page.nextCursor }));
  assert.equal(tail.nodeIds.length, 2); assert.equal(tail.nextCursor, null);
  const request = { ...basis(catalog), tabIds: [h.tabId] };
  keep('runtime-summary', await h.call('/api/workflow-organization/runtime-summary', request));
  keep('card-signals', await h.call('/api/workflow-organization/card-signals', request));
  const historyRoute = '/api/terminal-tabs/' + h.tabId + '/history?view=history&delta=1&last=80';
  keep('history-valid', await h.call(historyRoute)); await h.command('history-unknown');
  outputs['history-unknown'] = await h.call(historyRoute);
  assert.equal(outputs['history-unknown'].status, 409);
  assert.equal(outputs['history-unknown'].body.error, 'history_read_identity_unavailable');
  await h.command('history-valid');
  const recovered = keep('history-recovered', await h.call(historyRoute));
  assert.equal(recovered.writerConfirmed, false); assert.match(JSON.stringify(recovered.entries), /PRIVATE IOS35 HISTORY TEXT/);
  assert.equal(h.status().providerCalls, 0);
  if (process.env.IOS35_WIRE_DIR) {
    fs.mkdirSync(process.env.IOS35_WIRE_DIR, { recursive: true });
    for (const [name, value] of Object.entries(outputs)) fs.writeFileSync(path.join(process.env.IOS35_WIRE_DIR, name + '.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  }
});

test('held runtime/cards finish against the same catalog after duplicate publication baseline over actual SSE', async t => {
  const h = await fixture(t), catalog = (await h.call('/api/workflow-organization?projection=catalog-v2')).body;
  await h.command('hold-runtime'); await h.command('hold-cards');
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(h.baseUrl + '/api/events?scope=projects', {
    headers: { authorization: 'Bearer ' + h.token }, signal: controller.signal });
  const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
  const next = async () => {
    for (;;) {
      const index = pending.indexOf('\n\n');
      if (index >= 0) { const event = pending.slice(0, index); pending = pending.slice(index + 2);
        if (event.startsWith('data: ')) return JSON.parse(event.slice(6)); }
      else { const chunk = await reader.read(); assert.equal(chunk.done, false); pending += decoder.decode(chunk.value, { stream: true }); }
    }
  };
  const initial = await next(), request = { ...basis(catalog), tabIds: [h.tabId] };
  assert.deepEqual(initial.workflowPublication, catalog.workflowPublication);
  const runtime = h.call('/api/workflow-organization/runtime-summary', request), cards = h.call('/api/workflow-organization/card-signals', request);
  await Promise.all([h.whenRead('runtime'), h.whenRead('cards')]);
  await h.command('duplicate-publication'); const duplicate = await next();
  assert.deepEqual(duplicate.workflowPublication, initial.workflowPublication);
  assert.equal(duplicate.sequence, initial.sequence + 1);
  assert.deepEqual(h.status().held, ['runtime', 'cards']);
  assert.equal(h.status().counts.runtime, 1); assert.equal(h.status().counts.cards, 1);
  await h.command('release-runtime'); await h.command('release-cards');
  const [a, b] = await Promise.all([runtime, cards]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.body.tabs[0].ownBusy, true); assert.equal(a.body.tabs[0].liveKnown, true);
  assert.equal(b.body.coverage.complete, true);
  assert.equal(a.body.catalogClock, catalog.catalogClock); assert.equal(b.body.catalogClock, catalog.catalogClock);
  assert.deepEqual((await h.call('/api/workflow-organization?projection=catalog-v2')).body, catalog);
  if (process.env.IOS35_WIRE_DIR) for (const [name, value] of Object.entries({ 'publication-initial': initial, 'publication-duplicate': duplicate }))
    fs.writeFileSync(path.join(process.env.IOS35_WIRE_DIR, name + '.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  controller.abort(); await reader.cancel().catch(() => {});
});

test('private controls require test auth; mutations and production Send are outside fixture scope', async t => {
  const h = await fixture(t);
  assert.equal((await h.call('/__fixture/control', { action: 'history-valid' }, { auth: false })).status, 401);
  for (const route of ['/api/workflow-organization/mutations', '/api/terminal-tabs/' + h.tabId + '/send', '/api/workflows/main/terminal-tabs'])
    assert.equal((await h.call(route, {})).status, 404);
  assert.equal((await h.call('/__fixture/control', { action: 'restart' })).status, 400);
});

test('native chat-open status uses the same canonical read owner as History, never a saved writer', async t => {
  const h = await fixture(t), route = '/api/terminal-tabs/' + h.tabId;
  t.diagnostic('private HTTP ' + h.baseUrl + '; exact fixture listener and roots close through t.after');
  const status = await h.call(route + '/status');
  assert.equal(status.status, 200, 'native chat-open requires the paired public status route');
  const history = await h.call(route + '/history?view=history&delta=1&last=80');
  assert.equal(history.status, 200);
  assert.equal(status.body.coherent, true);
  assert.equal(status.body.readSessionId, history.body.readSessionId);
  assert.equal(status.body.codexReadSessionId, history.body.readSessionId);
  assert.equal(status.body.canCopySessionId, true);
  assert.equal(status.body.sessionId, null); assert.equal(status.body.codexSessionId, null);
  assert.equal(status.body.writerConfirmed, false); assert.equal(status.body.writerUsableForMutation, false);
  assert.equal(status.body.writerSessionId, null); assert.equal(status.body.sendTarget, null);
  const unchanged = await h.call(route + '/status');
  assert.equal(unchanged.body.runtimeRevision, status.body.runtimeRevision);
  await h.command('history-unknown');
  const unknown = await h.call(route + '/status');
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.readSessionId, null); assert.equal(unknown.body.codexReadSessionId, null);
  assert.equal(unknown.body.canCopySessionId, false); assert.equal(unknown.body.writerConfirmed, false);
  assert.equal(unknown.body.savedSessionId, history.body.readSessionId, 'saved SID is retained but cannot authorize read');
  assert.ok(unknown.body.runtimeRevision > status.body.runtimeRevision);
  assert.equal((await h.call(route + '/history?view=history&delta=1&last=80')).status, 409);
  await h.command('history-valid');
  const restored = await h.call(route + '/status');
  assert.equal(restored.status, 200); assert.equal(restored.body.readSessionId, history.body.readSessionId);
  assert.equal(restored.body.writerConfirmed, false); assert.equal(restored.body.writerSessionId, null);
  assert.ok(restored.body.runtimeRevision > unknown.body.runtimeRevision);
  assert.equal((await h.call(route + '/status', null, { auth: false })).status, 401);
  assert.equal((await h.call('/api/terminal-tabs/foreign/status')).status, 404);
  assert.equal((await h.call(route + '/status', {})).status, 404);
  assert.equal(h.status().providerCalls, 0); assert.equal(h.status().counts.status, 4);
  if (process.env.IOS35_WIRE_DIR) for (const [name, value] of Object.entries({
    'status-read-owner': status.body, 'status-unknown': unknown.body, 'status-read-restored': restored.body,
  })) fs.writeFileSync(path.join(process.env.IOS35_WIRE_DIR, name + '.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
});

test('bounded close removes only its private roots and releases the exact listener', async t => {
  const h = await fixture(t); const address = h.baseUrl;
  await h.close();
  assert.equal(fs.existsSync(h.root), false); assert.equal(fs.existsSync(h.historyRoot), false);
  await assert.rejects(fetch(address + '/__fixture/status'));
});
