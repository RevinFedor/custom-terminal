import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { Zap } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';

function declaration(file, name) {
  const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name);
  return ts.transpileModule(node.getText(ast).replace(/^export default /, ''), {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const Header = vm.runInNewContext(declaration('./HistoryAgentLaunchParameters.tsx', 'HistoryAgentLaunchParameters')
  + '\nHistoryAgentLaunchParameters;', { React, Zap });
const settings = sid => ({ version: 1, provider: 'codex', sessionId: sid,
  source: 'own-turn-context', model: 'gpt-6-luna', effort: 'max', timestamp: '2026-10-09T07:00:00Z' });
const serviceTier = (tier, sid = 'child-A') => ({ version: 1, provider: 'codex', sessionId: sid,
  source: 'own-thread-settings', serviceTier: tier, timestamp: '2026-10-15T06:00:00Z' });

test('actual navbar renders launch model/effort, not the generic agent title', () => {
  const html = renderToStaticMarkup(React.createElement(Header, { settings: settings('child-A'), taskLabel: 'Task A' }));
  assert.match(html, /data-history-agent-launch-model/);
  assert.match(html, /gpt-6-luna/); assert.match(html, />max</);
  assert.doesNotMatch(html, />Task A</); assert.doesNotMatch(html, />Subagent</);
});

test('unknown launch fields remain explicitly unknown without invented defaults', () => {
  const html = renderToStaticMarkup(React.createElement(Header, { settings: null, taskLabel: 'Task A' }));
  assert.match(html, /Модель —/); assert.match(html, /effort —/);
  assert.doesNotMatch(html, /gpt-|>max</);
});

test('initial unknown launch parameters show static skeletons, not final unknown dashes', () => {
  const html = renderToStaticMarkup(React.createElement(Header, {
    settings: null, provider: 'codex', taskLabel: 'A', loading: true,
  }));
  assert.match(html, /aria-busy="true"/);
  for (const field of ['model', 'effort', 'fast']) {
    assert.match(html, new RegExp('data-history-agent-launch-loading="' + field + '"'));
  }
  assert.match(html, /data-history-agent-launch-fast="loading"/);
  assert.match(html, /Fast/);
  assert.doesNotMatch(html, /Модель —|effort —|Fast —|Fast выкл\./);
  assert.doesNotMatch(html, /animation|animate-|setInterval|<svg/);
});

test('ready model and effort stay visible while only missing Fast is loading', () => {
  const html = renderToStaticMarkup(React.createElement(Header, {
    settings: settings('child-A'), taskLabel: 'A', loading: true,
  }));
  assert.match(html, /gpt-6-luna/); assert.match(html, />max</);
  assert.match(html, /data-history-agent-launch-loading="fast"/);
  assert.doesNotMatch(html, /data-history-agent-launch-loading="(?:model|effort)"/);
  assert.doesNotMatch(html, /Fast —/);
});

test('known Fast does not flash a skeleton during transcript loading', () => {
  const html = renderToStaticMarkup(React.createElement(Header, {
    settings: settings('child-A'), serviceTier: serviceTier('priority'), taskLabel: 'A', loading: true,
  }));
  assert.match(html, />Fast<\/span>/);
  assert.doesNotMatch(html, /data-history-agent-launch-loading|aria-busy="true"/);
});

test('Claude model without a proven effort is rendered partially, not as parent max', () => {
  const html = renderToStaticMarkup(React.createElement(Header, { settings: {
    ...settings('claude-A'), provider: 'claude', model: 'claude-haiku', effort: null }, taskLabel: 'Task A' }));
  assert.match(html, /claude-haiku/); assert.match(html, /effort —/); assert.doesNotMatch(html, />max</);
  assert.doesNotMatch(html, /data-history-agent-launch-fast/);
});

for (const [tier, label, marker] of [['priority', 'Fast', 'priority'], ['default', 'Fast выкл.', 'default'],
  [null, 'Fast —', 'unknown']]) {
  test(`actual header shows ${label} beside effort even with separate creation model proof`, () => {
    const html = renderToStaticMarkup(React.createElement(Header, { settings: {
      ...settings('child-A'), source: 'subagent-started' }, serviceTier: serviceTier(tier), taskLabel: 'A' }));
    assert.match(html, new RegExp('data-history-agent-launch-fast="' + marker + '"'));
    assert.ok(html.indexOf('data-history-agent-launch-effort') < html.indexOf('data-history-agent-launch-fast'));
    assert.ok(html.includes('>' + label + '</span>'));
    assert.equal(html.includes('<svg'), tier === 'priority');
    assert.doesNotMatch(html, /<button/);
  });
}

test('unknown/missing launch pair still shows Fast — for selected Codex; foreign tier stays unknown', () => {
  const unknown = renderToStaticMarkup(React.createElement(Header, { settings: null, provider: 'codex', taskLabel: 'A' }));
  assert.match(unknown, /Fast —/);
  const foreign = renderToStaticMarkup(React.createElement(Header, { settings: settings('child-B'),
    serviceTier: serviceTier('priority'), taskLabel: 'B' }));
  assert.match(foreign, /data-history-agent-launch-fast="unknown"/);
  assert.doesNotMatch(foreign, /<svg/);
});

test('actual selected-reader hook rejects stale A→B metadata and does not reread on model state update', async () => {
  const states = [], refs = [], pendingEffects = [], readRequests = [], releases = [];
  let stateIndex = 0, refIndex = 0, lastDeps = null, cleanup = null, nextTimer = 0, periodicTick = null;
  const set = (index, value) => { states[index] = typeof value === 'function' ? value(states[index]) : value; };
  const scope = {
    useState(initial) { const index = stateIndex++; if (!(index in states)) states[index] = initial;
      return [states[index], value => set(index, value)]; },
    useRef(initial) { const index = refIndex++; if (!(index in refs)) refs[index] = { current: initial }; return refs[index]; },
    useEffect(effect, deps) { if (!lastDeps || deps.some((value, index) => value !== lastDeps[index])) {
      if (cleanup) cleanup(); lastDeps = deps; pendingEffects.push(effect); } },
    ipcRenderer: { invoke(channel, request) {
      assert.equal(channel, 'subagent:read-steps');
      return new Promise(resolve => readRequests.push({ request, resolve }));
    }, send(channel, request) { releases.push({ channel, request }); } },
    window: { setInterval(tick) { periodicTick = tick; return ++nextTimer; }, clearInterval() {}, setTimeout() { return ++nextTimer; }, clearTimeout() {} },
    mergeHistoryTranscriptSteps: (before, next) => [...before, ...next],
    Date, Math,
  };
  const useReader = vm.runInNewContext(declaration('./HistoryPanel.tsx', 'useSubagentSteps') + '\nuseSubagentSteps;', scope);
  const chip = sid => ({ key: 'task:' + sid, kind: 'subagent', agentSessionId: sid, label: sid, startedAt: 100, status: 'running' });
  const render = sid => { stateIndex = 0; refIndex = 0;
    const value = useReader(chip(sid), 'tab-A', 'codex', '/private-fixture', 'parent-A');
    for (const effect of pendingEffects.splice(0)) cleanup = effect(); return value; };
  render('child-A'); assert.equal(readRequests.length, 1);
  const firstB = render('child-B');
  assert.equal(firstB.launchSettings, null); assert.equal(firstB.launchMetadataPending, true);
  assert.equal(readRequests.length, 2);
  readRequests[0].resolve({ success: true, steps: [], offset: 80, pending: false,
    launchSettings: settings('child-A'), launchServiceTier: serviceTier('priority') });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(render('child-B').launchSettings, null);
  assert.equal(render('child-B').launchServiceTier, null);
  assert.equal(render('child-B').launchMetadataPending, true, 'late A cannot finish B loading');
  readRequests[1].resolve({ success: true, steps: [], offset: 90, pending: false,
    launchSettings: settings('child-B'), launchServiceTier: serviceTier('default', 'child-B') });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(render('child-B').launchSettings.sessionId, 'child-B');
  assert.equal(render('child-B').launchServiceTier.serviceTier, 'default');
  assert.equal(render('child-B').launchMetadataPending, false);
  assert.equal(readRequests.length, 2, 'metadata changes do not create a new reader or invoke');
  assert.equal(refs[0].current, 90, 'same read offset remains authoritative');
  assert.equal(releases.length, 1, 'only replaced A reader was released');
  const snapshot = states[2];
  const repeatedRead = periodicTick();
  readRequests[2].resolve({ success: true, steps: [], offset: 90, pending: false,
    launchSettings: settings('child-B'), launchServiceTier: {
      ...serviceTier('default', 'child-B'), timestamp: 'different-but-same-scalars' } });
  await repeatedRead;
  assert.equal(states[2], snapshot, 'identical scalar metadata preserves the state reference');
  assert.equal(render('child-B').launchServiceTier.serviceTier, 'default');
  assert.equal(readRequests.length, 3);
  assert.equal(readRequests[2].request.readerId, readRequests[1].request.readerId);
  assert.equal(readRequests[2].request.offset, 90);
  const foreignRead = periodicTick();
  readRequests[3].resolve({ success: true, steps: [], offset: 90, pending: false,
    launchSettings: settings('child-B'), launchServiceTier: serviceTier('priority', 'child-A') });
  await foreignRead;
  assert.equal(render('child-B').launchServiceTier, null, 'foreign tier rejected even for the current request');
  const resetRead = periodicTick();
  readRequests[4].resolve({ success: true, steps: [], offset: 20, pending: false, reset: true });
  await resetRead;
  assert.equal(render('child-B').launchServiceTier, null);
  assert.equal(render('child-B').launchSettings, null, 'source reset clears old metadata at empty EOF');
  assert.equal(refs[0].current, 20);
  cleanup(); assert.equal(releases.length, 2);
});

let readerSource;
function loadingReader() {
  readerSource ||= declaration('./HistoryPanel.tsx', 'useSubagentSteps');
  const states = [], refs = [], requests = [], releases = [], drains = [];
  let stateIndex = 0, refIndex = 0, dependencies, effect, dispose, tail;
  const scope = {
    useState(initial) {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useRef(initial) {
      const index = refIndex++;
      return refs[index] ||= {current: initial};
    },
    useEffect(next, deps) {
      if (!dependencies || deps.some((value, index) => value !== dependencies[index])) {
        dispose?.(); dependencies = deps; effect = next;
      }
    },
    ipcRenderer: {
      invoke(channel, request) {
        assert.equal(channel, 'subagent:read-steps');
        return new Promise((resolve, reject) => requests.push({request, resolve, reject}));
      },
      send(channel, request) { releases.push({channel, request}); },
    },
    window: {
      setInterval(callback) { tail = callback; return 1; }, clearInterval() { tail = null; },
      setTimeout(callback) { drains.push(callback); return drains.length; }, clearTimeout() {},
    },
    mergeHistoryTranscriptSteps: (before, next) => [...before, ...next], Date, Math,
  };
  const useReader = vm.runInNewContext(readerSource + '\nuseSubagentSteps;', scope);
  return {states, requests, releases, drains,
    render(sid = 'child-A', status = 'running') {
      stateIndex = 0; refIndex = 0;
      const chip = sid ? {key: 'task:' + sid, kind: 'subagent', agentSessionId: sid, label: sid, startedAt: 100, status} : null;
      const result = useReader(chip, 'tab-A', 'codex', '/private-fixture', 'parent-A');
      if (effect) { const start = effect; effect = null; dispose = start(); }
      return result;
    },
    tick() { return tail?.(); },
    dispose() { dispose?.(); },
  };
}
const flushRead = async () => { await Promise.resolve(); await Promise.resolve(); };

test('launch metadata stays loading after first rows until catch-up, then final unknown uses dash', async () => {
  const h = loadingReader();
  assert.equal(h.render().launchMetadataPending, true, 'before the first effect/response');
  h.requests[0].resolve({success: true, steps: [{id: 's1', kind: 'text', text: 'row'}], offset: 40, pending: true});
  await flushRead();
  assert.equal(h.render().pending, false, 'existing transcript rows are already ready');
  assert.equal(h.render().launchMetadataPending, true, 'metadata phase is independent');
  assert.equal(h.drains.length, 1);
  h.drains.shift()();
  assert.equal(h.requests[1].request.offset, 40);
  assert.equal(h.requests[1].request.readerId, h.requests[0].request.readerId);
  h.requests[1].resolve({success: true, steps: [], offset: 80, pending: false});
  await flushRead();
  const ready = h.render();
  assert.equal(ready.launchMetadataPending, false);
  const html = renderToStaticMarkup(React.createElement(Header, {
    settings: ready.launchSettings, serviceTier: ready.launchServiceTier,
    provider: 'codex', taskLabel: 'A', loading: ready.launchMetadataPending,
  }));
  assert.match(html, /Модель —/); assert.match(html, /effort —/); assert.match(html, /Fast —/);
  assert.doesNotMatch(html, /data-history-agent-launch-loading/);
  const same = h.states[2];
  const tick = h.tick();
  h.requests[2].resolve({success: true, steps: [], offset: 80, pending: false});
  await tick;
  assert.equal(h.states[2], same, 'same metadata and phase retain the same reference');
  h.dispose(); assert.equal(h.releases.length, 1);
});

test('tail reads do not restart loading, but an exact source reset starts a new metadata phase', async () => {
  const h = loadingReader(); h.render();
  h.requests[0].resolve({success: true, steps: [], offset: 80, pending: false}); await flushRead();
  assert.equal(h.render().launchMetadataPending, false);
  const append = h.tick();
  h.requests[1].resolve({success: true, steps: [{id: 's2'}], offset: 100, pending: true}); await append;
  assert.equal(h.render().launchMetadataPending, false, 'no skeleton flash on ordinary tail');
  const reset = h.tick();
  h.requests[2].resolve({success: true, steps: [], offset: 20, pending: true, reset: true}); await reset;
  assert.equal(h.render().launchMetadataPending, true);
  const end = h.tick();
  h.requests[3].resolve({success: true, steps: [], offset: 40, pending: false}); await end;
  assert.equal(h.render().launchMetadataPending, false);
  assert.equal(new Set(h.requests.map(value => value.request.readerId)).size, 1);
  h.dispose();
});

test('initial reader errors settle to unknown; late cancelled errors cannot finish another child loading', async () => {
  const h = loadingReader(); h.render();
  h.requests[0].reject(new Error('controlled read unavailable')); await flushRead();
  assert.equal(h.render().launchMetadataPending, false);
  const retry = h.tick();
  h.render('child-B');
  assert.equal(h.render('child-B').launchMetadataPending, true);
  h.requests[1].reject(new Error('late A')); await retry;
  assert.equal(h.render('child-B').launchMetadataPending, true);
  h.requests[2].resolve({success: false, error: 'controlled B error'}); await flushRead();
  assert.equal(h.render('child-B').launchMetadataPending, false);
  h.dispose();
});

test('finished missing/unfinished child has no perpetual skeleton or new periodic reader', async () => {
  const h = loadingReader(); h.render('child-A', 'completed');
  h.requests[0].resolve({success: true, steps: [], offset: 0, pending: true}); await flushRead();
  assert.equal(h.render('child-A', 'completed').launchMetadataPending, false);
  assert.equal(h.tick(), undefined);
  assert.equal(h.requests.length, 1);
  assert.equal(h.render(null).launchMetadataPending, false);
  assert.equal(h.releases.length, 1);
  h.dispose();
});

test('Inspector forwards its selected reader metadata phase to the existing header', () => {
  const source = fs.readFileSync(new URL('./HistoryPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /launchMetadataPending\s*}\s*=\s*useSubagentSteps\(/);
  assert.match(source, /<HistoryAgentLaunchParameters[^>]+loading=\{launchMetadataPending}/);
});
