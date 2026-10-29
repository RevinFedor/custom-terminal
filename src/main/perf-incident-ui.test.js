'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { createLayoutRootCollector, collectIncidentUiMetadata, sanitizeUiNode, rendererUiProbe,
  UI_METADATA_LIMIT, UI_COLLECTION_BUDGET_MS, MAX_ROOTS, MAX_ANIMATIONS } = require('./perf-incident-ui');
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
const probe = (animations, options = {}, globals = {}) => vm.runInNewContext(
  `(${rendererUiProbe.toString()})(options, ${sanitizeUiNode.toString()}, target)`, {
    document: { getAnimations: () => animations }, performance, target: null,
    options: { mode: 'document', limit: MAX_ANIMATIONS, maxBytes: 32768, budgetMs: UI_COLLECTION_BUDGET_MS, ...options },
    ...globals,
  });
const animation = (cssName, playState) => ({ animationName: cssName, playState });
const names = result => Array.from(result.entries, entry => entry.cssName);
const entryBytes = entries => entries.reduce((bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry)) + 1, 0);
const rootElement = animations => ({ nodeType: 1, localName: 'svg', parentElement: null, style: { opacity: '' },
  getAttribute: () => null, hasAttribute: () => false,
  getAnimations(options) { assert.equal(options.subtree, true); return animations; } });

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
  const document = { getAnimations: () => animations };
  const forbidden = () => { throw new Error('private or layout read ' + CANARY); };
  for (const element of [target, ancestor, document]) {
    for (const key of ['textContent', 'innerHTML', 'outerHTML', 'value', 'title', 'href', 'URL', 'location',
      'offsetTop', 'offsetLeft', 'offsetWidth', 'offsetHeight', 'clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight']) {
      Object.defineProperty(element, key, { get: forbidden });
    }
    element.getBoundingClientRect = forbidden; element.getClientRects = forbidden;
  }
  const animations = Array.from({ length: 300 }, () => ({ animationName: 'cb-terminal-perimeter-travel', playState: 'running', effect: { target } }));
  target.getAnimations = options => { assert.equal(options.subtree, true); return animations; };
  for (const mode of ['document', 'root']) {
    const output = probe(animations, { mode, limit: 9999, maxBytes: 1000000, budgetMs: 1000 }, {
      document, target, getComputedStyle: forbidden, getSelection: forbidden, fetch: forbidden,
    });
    assert.equal(output.entries.length, mode === 'document' ? 256 : 32); assert.equal(output.countLimited, true);
    const metadata = mode === 'document' ? output.entries[0].target : output.node;
    assert.equal(metadata.owners.tab, 'fixture-hidden-tab'); assert.equal(metadata.inlineOpacityZero, true);
    assert.equal(metadata.isolatedPane, true); assert.equal(metadata.inertAncestor, true);
    assert.ok(!JSON.stringify(output).includes(CANARY));
  }
});

test('root probe reports descendant animation names and obeys payload budget', () => {
  const element = { nodeType: 1, localName: 'svg', parentElement: null, style: { opacity: '' },
    getAttribute: () => null, hasAttribute: () => false,
    getAnimations(options) { assert.equal(options.subtree, true); return Array.from({ length: 80 }, () => ({ animationName: 'perimeter', playState: 'running' })); } };
  const result = vm.runInNewContext(`(${rendererUiProbe.toString()})({mode:'root',maxBytes:160,budgetMs:1000}, ${sanitizeUiNode.toString()}, target)`, { target: element, performance });
  assert.equal(result.node.tag, 'svg'); assert.ok(result.entries.length < 32);
  assert.equal(result.sizeLimited, true); assert.equal(result.countLimited, true);
});

test('running candidates after many paused records retain byte credit, with stable order in both partitions', () => {
  const animations = Array.from({ length: 90 }, (_, i) => animation('paused-' + i, 'paused'));
  animations.push(animation('idle-a', 'idle'), animation('running-a', 'running'), animation('finished-a', 'finished'),
    animation('running-b', 'running'), animation('unknown-a', CANARY), animation('running-c', 'running'),
    animation('paused-tail', 'paused'));
  const full = probe(animations);
  const expectedRunning = ['running-a', 'running-b', 'running-c'];
  assert.deepEqual(names(full), [...expectedRunning,
    ...animations.filter(a => a.playState !== 'running').map(a => a.animationName)]);
  assert.equal(full.entries.find(a => a.cssName === 'unknown-a').playState, 'unknown');
  assert.equal(full.countLimited, false); assert.equal(full.sizeLimited, false); assert.equal(full.timeLimited, false);
  const credit = entryBytes(full.entries.slice(0, 3));
  const limited = probe(animations, { maxBytes: credit });
  assert.deepEqual(names(limited), expectedRunning);
  assert.equal(entryBytes(limited.entries), credit);
  assert.equal(limited.observedCount, 97); assert.equal(limited.scannedCount, 97);
  assert.equal(limited.selection, 'running-first-capped-prefix');
  assert.equal(limited.countLimited, false); assert.equal(limited.sizeLimited, true); assert.equal(limited.timeLimited, false);
  assert.ok(!JSON.stringify(limited).includes(CANARY));
  const emptyCredit = probe(animations, { maxBytes: 0 });
  assert.equal(emptyCredit.entries.length, 0); assert.equal(emptyCredit.scannedCount, 97);
  assert.equal(emptyCredit.sizeLimited, true); assert.equal(emptyCredit.timeLimited, false);
});

test('selection only scans the old document/root prefix, including when all later animations are running', () => {
  for (const { mode, cap, limit } of [{ mode: 'document', cap: 256, limit: 9999 },
    { mode: 'document', cap: 5, limit: 5 }, { mode: 'root', cap: 32, limit: 9999 }]) {
    let stateReads = 0, indexReads = 0;
    const records = Array.from({ length: cap + 44 }, (_, index) => ({ animationName: 'prefix-' + index,
      get playState() { stateReads++; return index >= cap - 2 ? 'running' : 'paused'; },
      get effect() { assert.equal(mode, 'document', 'root mode does not describe animation targets'); return null; } }));
    const animations = new Proxy(records, {
      get(source, key) {
        if (key === 'length') return source.length;
        assert.match(String(key), /^\d+$/, 'no full-array sort/map/iterator');
        const index = Number(key);
        assert.ok(index < cap, 'never inspect the suffix, even for running candidates');
        indexReads++;
        return source[index];
      },
    });
    const result = probe(animations, { mode, limit, maxBytes: 1000000 }, { target: rootElement(animations) });
    assert.equal(result.entries.length, cap); assert.equal(result.observedCount, cap + 44);
    assert.equal(result.scannedCount, cap); assert.equal(result.countLimited, true);
    assert.equal(result.sizeLimited, false); assert.equal(result.timeLimited, false);
    assert.equal(indexReads, cap); assert.equal(stateReads, cap, 'one sampled state per bounded candidate');
    assert.deepEqual(names(result), ['prefix-' + (cap - 2), 'prefix-' + (cap - 1),
      ...Array.from({ length: cap - 2 }, (_, i) => 'prefix-' + i)]);
  }
});

test('selection and projection share the original time budget in document and root modes', () => {
  for (const mode of ['document', 'root']) {
    let now = 0, reads = 0;
    const animations = new Proxy({ length: 300 }, { get(source, key) {
      if (key === 'length') return source.length;
      assert.ok(Number(key) < 3, 'no new candidate after the deadline');
      return {
        get playState() { if (++reads === 3) now = UI_COLLECTION_BUDGET_MS; return 'running'; },
        get animationName() { assert.fail('no projection after scan expires'); },
        get effect() { assert.fail('no owner reads during selection'); },
      };
    } });
    const timed = probe(animations, { mode }, { performance: { now: () => now }, target: rootElement(animations) });
    assert.equal(timed.observedCount, 300); assert.equal(timed.scannedCount, 3);
    assert.equal(timed.entries.length, 0); assert.equal(timed.countLimited, true);
    assert.equal(timed.timeLimited, true); assert.equal(timed.sizeLimited, false);

    now = 0;
    const one = [{ playState: 'running', get animationName() { now = UI_COLLECTION_BUDGET_MS; return 'last-running'; } }];
    const late = probe(one, { mode }, { performance: { now: () => now }, target: rootElement(one) });
    assert.equal(late.scannedCount, 1); assert.equal(late.entries.length, 1);
    assert.equal(late.timeLimited, true, 'deadline reached by the last projection is still reported');
    assert.equal(late.countLimited, false); assert.equal(late.sizeLimited, false);
  }
});

test('empty and unavailable animation APIs preserve zero scanned counts and explicit availability', () => {
  const empty = probe([]);
  assert.equal(empty.observedCount, 0); assert.equal(empty.scannedCount, 0);
  assert.equal(empty.entries.length, 0); assert.equal(empty.countLimited, false);
  assert.equal(empty.sizeLimited, false); assert.equal(empty.timeLimited, false);
  for (const mode of ['document', 'root']) {
    const missing = probe([], { mode }, { document: {}, target: null });
    assert.equal(missing.unavailable, true); assert.equal(missing.scannedCount, 0);
    assert.equal(missing.entries.length, 0); assert.equal(missing.sizeLimited, false);
  }
});

test('serialized probe selection/counters survive main projection and the unchanged sidecar cap', async () => {
  const target = rootElement([]);
  target.getAttribute = key => key === 'class'
    ? Array.from({ length: 12 }, (_, i) => 'fixture-' + i + '-' + 'x'.repeat(45)).join(' ') : null;
  const animations = Array.from({ length: 98 }, (_, i) => ({ ...animation('paused-' + i, 'paused'), effect: { target } }));
  animations.push({ ...animation('running-a', 'running'), effect: { target } },
    { ...animation('running-b', 'running'), effect: { target } }, { ...animation('running-c', 'running'), effect: { target } });
  const subtree = Array.from({ length: 80 }, (_, i) => animation('root-' + i + '-' + 'x'.repeat(85),
    i === 30 || i === 31 ? 'running' : 'paused'));
  const root = rootElement(subtree);
  const result = await collectIncidentUiMetadata({ captureStopped: true, isOwned: () => true, traceRoots: roots([7]),
    sendCommand: async (method, params) => {
      if (method === 'Runtime.evaluate') return response(vm.runInNewContext(params.expression, {
        document: { getAnimations: () => animations }, performance,
      }));
      if (method === 'DOM.resolveNode') return { object: { objectId: 'fixture-root' } };
      if (method === 'Runtime.callFunctionOn') return response(vm.runInNewContext(`(${params.functionDeclaration}).call(target)`, {
        target: root, performance,
      }));
      return {};
    } });
  assert.equal(result.schema, 'noted-incident-ui-v1'); assert.equal(result.status, 'partial');
  assert.deepEqual(result.limits, { durationMs: 1500, bytes: 65536, animations: 256, roots: 24 });
  assert.deepEqual(result.animations.slice(0, 3).map(a => a.cssName), ['running-a', 'running-b', 'running-c']);
  assert.equal(result.animationInventory.observedCount, 101); assert.equal(result.animationInventory.scannedCount, 101);
  assert.equal(result.animationInventory.selection, 'running-first-capped-prefix');
  assert.equal(result.animationInventory.sizeLimited, true); assert.equal(result.animationInventory.countLimited, false);
  assert.equal(result.animationInventory.timeLimited, false);
  assert.ok(result.animations.length < 101); assert.ok(entryBytes(result.animations) <= 32768);
  const projectedRoot = result.roots[0];
  assert.equal(projectedRoot.observedCount, 80); assert.equal(projectedRoot.scannedCount, 32);
  assert.equal(projectedRoot.selection, 'running-first-capped-prefix');
  assert.equal(projectedRoot.countLimited, true); assert.equal(projectedRoot.sizeLimited, true);
  assert.equal(projectedRoot.timeLimited, false);
  assert.deepEqual(Array.from(projectedRoot.subtreeAnimations.slice(0, 2), a => a.cssName), [subtree[30].animationName, subtree[31].animationName]);
  assert.ok(entryBytes(projectedRoot.subtreeAnimations) <= 4096);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= UI_METADATA_LIMIT);
  assert.equal(result.objectGroupRelease, 'confirmed'); assert.ok(!JSON.stringify(result).includes(CANARY));
});

test('main validates untrusted Runtime payloads, caps 256 animations / 24 roots / 64 KiB, releases private group', async () => {
  const calls = [];
  const result = await collectIncidentUiMetadata({ captureStopped: true, zoomFactor: 2, isOwned: () => true,
    traceRoots: { ...roots(Array.from({ length: 70 }, (_, i) => i + 1)), text: CANARY },
    sendCommand: async (method, params) => {
      calls.push({ method, params });
      if (method === 'DOM.resolveNode') return { object: { objectId: 'node-' + params.backendNodeId } };
      if (method === 'Runtime.evaluate') return response({ observedCount: 1000, scannedCount: CANARY, selection: CANARY, text: CANARY,
        entries: Array.from({ length: 1000 }, () => ({ ...entry, value: CANARY, title: CANARY, url: CANARY,
          target: { ...node, inspector: 'https://example.invalid/' + CANARY, owners: { tab: '../' + CANARY }, html: CANARY } })) });
      if (method === 'Runtime.callFunctionOn') return response({ node: { ...node, text: CANARY }, entries: [entry],
        observedCount: 80, scannedCount: 9999, selection: CANARY });
      return {};
    } });
  assert.equal(result.status, 'partial'); assert.equal(result.zoomFactor, 2);
  assert.ok(result.animations.length <= MAX_ANIMATIONS); assert.equal(result.trace.roots.length, MAX_ROOTS);
  assert.equal(result.animationInventory.scannedCount, null); assert.equal(result.animationInventory.selection, null);
  assert.equal(result.animationInventory.countLimited, true);
  assert.ok(result.roots.every(root => root.scannedCount === null && root.selection === null && root.countLimited));
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
