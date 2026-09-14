'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { createLayoutRootCollector, collectIncidentUiMetadata, sanitizeUiNode, rendererUiProbe,
  UI_METADATA_LIMIT, MAX_ROOTS, MAX_ANIMATIONS } = require('./perf-incident-ui');
const CANARY = 'SECRET_INPUT_TEXT_TITLE_URL_CANARY_8d092';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const event = (ids, pid = 12) => JSON.stringify({ name: 'LocalFrameView::layout', pid,
  args: { endData: { layoutRoots: ids.map(nodeId => ({ nodeId, depth: 35, text: CANARY })) } } }) + ',\n';
const roots = ids => ({ roots: ids.map(backendNodeId => ({ backendNodeId, occurrences: 78 })) });
const node = { tag: 'svg', classes: ['fixture-TerminalActivityIcon'],
  inspector: 'packages/claude-blocks/src/components/TerminalActivityIcon.tsx:10:5:svg',
  owners: { tab: 'fixture-hidden-tab', pane: 'fixture-space:window-2', history: 'aabbccdd' },
  isolatedPane: true, inlineOpacityZero: true, inlineAncestorOpacity: [{ depth: 2, opacity: 0 }] };
const entry = { cssName: 'cb-terminal-perimeter-travel', playState: 'running', target: node };
const response = value => ({ result: { value } });

test('layout IDs survive byte boundaries and an incomplete trace tail without retaining event text', () => {
  const collector = createLayoutRootCollector({ rendererPid: 12 });
  const bytes = Buffer.from('{"traceEvents":[\n' + event([753, 3163]) + event([753])
    + event([999], 77) + '{"name":"other","args":{"note":"Привет"}},\n' + event([683]).slice(0, -20));
  for (let i = 0; i < bytes.length; i += 7) collector.write(bytes.subarray(i, i + 7));
  const result = collector.finish(false);
  assert.deepEqual(result.roots, [{ backendNodeId: 753, occurrences: 2 }, { backendNodeId: 3163, occurrences: 1 }]);
  assert.ok(result.incompleteTailBytes > 0); assert.equal(result.completeExport, false);
  assert.equal(result.malformedLayoutLines, 0); assert.ok(!JSON.stringify(result).includes(CANARY));
  collector.write(event([100])); assert.deepEqual(collector.finish(true), result, 'finalized parser ignores late chunks');
});

test('oversize carry is dropped until newline, then parsing resumes; root count is capped', () => {
  const bounded = createLayoutRootCollector({ maxCarryBytes: 256 });
  bounded.write('x'.repeat(200)); bounded.write('x'.repeat(200)); bounded.write('x'.repeat(200) + '\n' + event([7]));
  const a = bounded.finish(true);
  assert.equal(a.overlongLines, 1); assert.deepEqual(a.roots, [{ backendNodeId: 7, occurrences: 1 }]);
  const collector = createLayoutRootCollector({ maxRoots: 9999 });
  collector.write(event(Array.from({ length: 100 }, (_, i) => i + 1)));
  const b = collector.finish(true);
  assert.equal(b.roots.length, MAX_ROOTS); assert.equal(b.ignoredRootOccurrences, 100 - MAX_ROOTS);
  assert.ok(Buffer.byteLength(JSON.stringify(b)) < 4096);
});

test('metadata probe reads only allowed attributes and inline opacity, never content or layout', () => {
  const allowed = new Set(['class', 'data-insp-path', 'data-terminal-pane-wrapper', 'data-terminal-pane-chrome-host',
    'data-history-owner', 'data-history-composer-tab-id', 'data-terminal-layer-tab-id', 'data-tab-id',
    'data-space-id', 'data-pane-key', 'data-pane-focus-isolated', 'aria-hidden']);
  const ancestor = { nodeType: 1, localName: 'section', parentElement: null, style: { opacity: '0' },
    getAttribute(key) { assert.ok(allowed.has(key)); return { 'data-terminal-pane-wrapper': 'fixture-hidden-tab', 'data-pane-focus-isolated': '1' }[key] || null; },
    hasAttribute(key) { assert.equal(key, 'inert'); return true; } };
  const target = { nodeType: 1, localName: 'circle', parentElement: ancestor, style: { opacity: '' },
    getAttribute(key) { assert.ok(allowed.has(key)); return { class: 'cb-terminal-perimeter-loader-dot', 'data-insp-path': node.inspector }[key] || null; },
    hasAttribute(key) { assert.equal(key, 'inert'); return false; } };
  for (const key of ['textContent', 'innerHTML', 'outerHTML', 'value', 'title', 'href']) {
    Object.defineProperty(target, key, { get() { throw new Error('private read ' + CANARY); } });
  }
  const animations = Array.from({ length: 300 }, () => ({ animationName: 'cb-terminal-perimeter-travel', playState: 'running', effect: { target } }));
  const output = vm.runInNewContext(`(${rendererUiProbe.toString()})({mode:'document',limit:9999,maxBytes:1000000,budgetMs:1000}, ${sanitizeUiNode.toString()}, null)`, {
    document: { getAnimations: () => animations }, performance,
    getComputedStyle() { throw new Error('must not compute layout'); },
    getSelection() { throw new Error('must not touch selection'); },
  });
  assert.equal(output.entries.length, 256); assert.equal(output.countLimited, true);
  assert.equal(output.entries[0].target.owners.tab, 'fixture-hidden-tab');
  assert.equal(output.entries[0].target.inlineOpacityZero, true);
  assert.equal(output.entries[0].target.isolatedPane, true); assert.equal(output.entries[0].target.inertAncestor, true);
  assert.ok(!JSON.stringify(output).includes(CANARY));
});

test('root probe reports descendant animation names and obeys payload budget', () => {
  const element = { nodeType: 1, localName: 'svg', parentElement: null, style: { opacity: '' },
    getAttribute: () => null, hasAttribute: () => false,
    getAnimations(options) { assert.equal(options.subtree, true); return Array.from({ length: 80 }, () => ({ animationName: 'perimeter', playState: 'running' })); } };
  const result = vm.runInNewContext(`(${rendererUiProbe.toString()})({mode:'root',maxBytes:160,budgetMs:1000}, ${sanitizeUiNode.toString()}, target)`, { target: element, performance });
  assert.equal(result.node.tag, 'svg'); assert.ok(result.entries.length < 32);
  assert.equal(result.sizeLimited, true); assert.equal(result.countLimited, true);
});

test('main validates untrusted Runtime payloads, caps 256 animations / 24 roots / 64 KiB, releases private group', async () => {
  const calls = [];
  const result = await collectIncidentUiMetadata({ captureStopped: true, zoomFactor: 2, isOwned: () => true,
    traceRoots: { ...roots(Array.from({ length: 70 }, (_, i) => i + 1)), text: CANARY },
    sendCommand: async (method, params) => {
      calls.push({ method, params });
      if (method === 'DOM.resolveNode') return { object: { objectId: 'node-' + params.backendNodeId } };
      if (method === 'Runtime.evaluate') return response({ observedCount: 1000, text: CANARY,
        entries: Array.from({ length: 1000 }, () => ({ ...entry, value: CANARY, title: CANARY, url: CANARY,
          target: { ...node, inspector: 'https://example.invalid/' + CANARY, owners: { tab: '../' + CANARY }, html: CANARY } })) });
      if (method === 'Runtime.callFunctionOn') return response({ node: { ...node, text: CANARY }, entries: [entry] });
      return {};
    } });
  assert.equal(result.status, 'partial'); assert.equal(result.zoomFactor, 2);
  assert.ok(result.animations.length <= MAX_ANIMATIONS); assert.equal(result.trace.roots.length, MAX_ROOTS);
  assert.equal(result.roots.length, MAX_ROOTS); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= UI_METADATA_LIMIT);
  assert.ok(!JSON.stringify(result).includes(CANARY));
  assert.equal(result.objectGroupRelease, 'confirmed');
  assert.ok(calls.every(call => call.params.objectGroup === result.objectGroup));
  assert.equal(calls.at(-1).method, 'Runtime.releaseObjectGroup');
  assert.ok(result.roots.every(root => root.subtreeAnimations[0].cssName === entry.cssName));
});

test('late responses do not resume collection or mutate the report; late handles get the same group cleanup', async () => {
  const calls = [];
  const started = performance.now();
  const result = await collectIncidentUiMetadata({ captureStopped: true, isOwned: () => true, traceRoots: roots([7]), budgetMs: 60,
    sendCommand: async (method, params) => {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') { await wait(140); return response({ entries: [entry] }); }
      return {};
    } });
  assert.ok(performance.now() - started < 120); assert.ok(result.errors.some(error => error.code === 'time-limit'));
  assert.equal(result.animations.length, 0); assert.equal(result.roots.length, 0);
  const saved = JSON.stringify(result); await wait(150);
  assert.equal(JSON.stringify(result), saved);
  assert.ok(!calls.some(call => call.method === 'DOM.resolveNode'));
  assert.ok(calls.filter(call => call.method === 'Runtime.releaseObjectGroup').length >= 1);
  assert.ok(calls.every(call => call.params.objectGroup === result.objectGroup));
});

test('ownership lost during resolve forbids node inspection and release through a replacement debugger', async () => {
  let owned = true;
  const calls = [];
  const result = await collectIncidentUiMetadata({ captureStopped: true, isOwned: () => owned, traceRoots: roots([7, 8]),
    sendCommand: async method => {
      calls.push(method);
      if (method === 'Runtime.evaluate') return response({ entries: [entry] });
      if (method === 'DOM.resolveNode') { owned = false; return { object: { objectId: CANARY } }; }
    } });
  assert.deepEqual(calls, ['Runtime.evaluate', 'DOM.resolveNode']);
  assert.equal(result.objectGroupRelease, 'ownership-lost');
  assert.ok(result.errors.some(error => error.code === 'ownership-lost'));
  assert.ok(!JSON.stringify(result).includes(CANARY));
});

test('unconfirmed stop skips all metadata commands and still preserves partial trace roots', async () => {
  const result = await collectIncidentUiMetadata({ captureStopped: false, isOwned: () => true, traceRoots: roots([753]),
    sendCommand() { throw new Error('must not run observer inside capture'); } });
  assert.equal(result.status, 'skipped'); assert.equal(result.reason, 'capture-stop-unconfirmed');
  assert.equal(result.trace.roots[0].backendNodeId, 753);
});

test('errors expose fixed codes only, including failed object-group cleanup', async () => {
  const result = await collectIncidentUiMetadata({ captureStopped: true, isOwned: () => true, traceRoots: roots([1]),
    sendCommand: async () => { throw Object.assign(new Error(CANARY), { uiCode: CANARY }); } });
  assert.equal(result.status, 'partial'); assert.ok(result.errors.some(error => error.stage === 'release'));
  assert.ok(result.errors.every(error => error.code === 'command-failed'));
  assert.ok(!JSON.stringify(result).includes(CANARY));
});

test('different incidents never share a remote object group', async () => {
  const capture = () => collectIncidentUiMetadata({ captureStopped: true, isOwned: () => true,
    sendCommand: async method => method === 'Runtime.evaluate' ? response({ entries: [] }) : {} });
  const a = await capture(), b = await capture();
  assert.notEqual(a.objectGroup, b.objectGroup);
});

test('cleanup is still issued if the host loop resumes after the whole deadline', async () => {
  const calls = [];
  const result = await collectIncidentUiMetadata({ captureStopped: true, isOwned: () => true, budgetMs: 30,
    sendCommand: async method => {
      calls.push(method);
      if (method === 'Runtime.evaluate') {
        const until = performance.now() + 50; while (performance.now() < until) { /* simulate a stalled host loop */ }
        return response({ entries: [] });
      }
      return {};
    } });
  assert.equal(result.objectGroupRelease, 'requested-after-deadline');
  assert.ok(calls.includes('Runtime.releaseObjectGroup'));
  assert.equal(result.status, 'partial'); assert.equal(result.animations.length, 0);
});
