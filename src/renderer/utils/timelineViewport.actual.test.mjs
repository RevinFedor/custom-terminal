import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { createTimelineViewportSource } from './timelineViewport.mjs';

function store(initial) {
  let value = initial;
  const listeners = new Set();
  return { read: () => value, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { value = next; for (const fn of [...listeners]) fn(); }, listeners };
}

test('keyed updates touch only changed mounted rows, not historical entries', () => {
  for (const n of [100, 3000, 26000]) {
    let reads = 0;
    const entries = new Proxy(Array.from({ length: n }, (_, i) => ({ uuid: 'u' + i })), {
      get(target, key) { if (/^\d+$/.test(String(key))) reads++; return Reflect.get(target, key); },
    });
    const state = store(['u7']);
    const source = createTimelineViewportSource({ entries, ...state });
    const calls = [], stops = [];
    for (let i = 0; i < n; i++) stops.push(source.bind(i).subscribe(() => calls.push(i)));
    stops.push(source.bind(0, n).subscribe(() => calls.push('whole-group')));
    assert.equal(state.listeners.size, 1);
    reads = 0;
    state.set(['u8']);
    assert.deepEqual(calls.sort((a,b) => a-b), [7,8]);
    assert.equal(reads, 0, 'no entries traversal in the viewport handler');
    calls.length = 0;
    state.set(['u8','u8']); state.set(['u8']);
    assert.deepEqual(calls, [], 'unchanged IDs never notify, including duplicate wire IDs');
    for (const stop of stops) stop();
    assert.equal(state.listeners.size, 0);
    state.set(['u7']); assert.deepEqual(calls, [], 'no leaked listeners');
  }
});

test('repeated UUIDs, compact summaries and collapsed any-member match the original visibility rule', () => {
  const entries = [{uuid:'repeat'}, {uuid:'boundary'}, {uuid:'summary',isCompactSummary:true},
    {uuid:'summary2',isCompactSummary:true}, {uuid:'repeat'}, {uuid:'tail'}];
  const state = store(['repeat']), source = createTimelineViewportSource({ entries, ...state });
  const singles = entries.map((_, i) => source.bind(i));
  const group = source.bind(1, 4), calls = [];
  const stops = singles.map((binding, i) => binding.subscribe(() => calls.push(i)));
  stops.push(group.subscribe(() => calls.push('group')));
  for (const ids of [['boundary'], ['summary'], ['summary2'], ['tail'], [], ['repeat'], ['boundary','repeat']]) {
    calls.length = 0;
    const before = singles.map(binding => binding.getSnapshot()), beforeGroup = group.getSnapshot();
    state.set(ids);
    const expected = entries.map((e,i) => ids.includes(e.uuid) || !!(e.isCompactSummary && i > 0 && ids.includes(entries[i-1].uuid)));
    assert.deepEqual(singles.map(binding => binding.getSnapshot()), expected);
    assert.equal(group.getSnapshot(), expected.slice(1,5).some(Boolean));
    assert.deepEqual(new Set(calls), new Set(expected.flatMap((active,i) => active !== before[i] ? [i] : [])
      .concat(beforeGroup !== expected.slice(1,5).some(Boolean) ? ['group'] : [])));
  }
  stops.forEach(stop => stop());
});

test('snapshot is fresh before subscription, while detached, and after reset/reentry', () => {
  const state = store(['a']), entries = [{uuid:'a'}, {uuid:'b'}];
  const source = createTimelineViewportSource({ entries, ...state }), a = source.bind(0), b = source.bind(1);
  assert.equal(a.getSnapshot(), true);
  state.set(['b']);
  assert.equal(a.getSnapshot(), false); assert.equal(b.getSnapshot(), true);
  let notifications = 0;
  const stop = b.subscribe(() => notifications++);
  state.set(undefined);
  assert.equal(b.getSnapshot(), false); assert.equal(notifications, 1);
  stop(); state.set(['a']);
  assert.equal(a.getSnapshot(), true);
  const stopAgain = a.subscribe(() => notifications++);
  assert.equal(a.getSnapshot(), true);
  stopAgain(); assert.equal(state.listeners.size, 0);
  // Another source with the same indices cannot inherit an old binding.
  const replacement = createTimelineViewportSource({ entries: [{uuid:'other'}], ...state });
  assert.equal(replacement.bind(0).getSnapshot(), false);
});

test('all snapshots commit before a synchronous subscriber reads another affected row', () => {
  const state = store(['a']), source = createTimelineViewportSource({ entries: [{uuid:'a'},{uuid:'b'}], ...state });
  const a = source.bind(0), b = source.bind(1), reads = [];
  const stops = [a.subscribe(() => reads.push([a.getSnapshot(), b.getSnapshot()])),
    b.subscribe(() => reads.push([a.getSnapshot(), b.getSnapshot()]))];
  state.set(['b']);
  assert.deepEqual(reads, [[false,true],[false,true]]);
  stops.forEach(stop => stop());
});

test('a store change during connection closes the render-to-subscribe gap', () => {
  const state = store(['a']);
  const source = createTimelineViewportSource({ entries: [{uuid:'a'}], read: state.read,
    subscribe: notify => { state.set([]); return state.subscribe(notify); } });
  const a = source.bind(0); assert.equal(a.getSnapshot(), true);
  let calls = 0;
  const stop = a.subscribe(() => calls++);
  assert.equal(a.getSnapshot(), false); assert.equal(calls, 1);
  stop(); assert.equal(state.listeners.size, 0);
});

test('synchronous unmount suppresses a captured callback and cleanup is idempotent', () => {
  const state = store(['a']), source = createTimelineViewportSource({ entries: [{uuid:'a'},{uuid:'b'}], ...state });
  const calls = [];
  let stopB;
  const stopA = source.bind(0).subscribe(() => { calls.push('a'); stopB(); });
  stopB = source.bind(1).subscribe(() => calls.push('b'));
  state.set(['b']);
  assert.deepEqual(calls, ['a']);
  stopA(); stopA(); stopB(); assert.equal(state.listeners.size, 0);
  const stopAgain = source.bind(0).subscribe(() => calls.push('again'));
  state.set(['a']); assert.deepEqual(calls, ['a','again']); stopAgain();
});

test('actual React row, beginning markers and parent map frame keep viewport work local', () => {
  const text = fs.readFileSync(new URL('../components/Workspace/Timeline.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('Timeline.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = new Map();
  let map, parent;
  const walk = node => {
    if (ts.isVariableDeclaration(node)) declarations.set(node.name.getText(ast), node);
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'Timeline') parent = node;
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'entries.map'
      && node.getText(ast).includes('<TimelineSegmentRow')) map = node;
    ts.forEachChild(node, walk);
  };
  walk(ast);
  assert.ok(parent && map);
  const parentText = parent.getText(ast);
  assert.doesNotMatch(parentText, /useUIStore\(state\s*=>\s*state\.historyVisibleUuids/,
    'the real parent must not subscribe to the UUID array');
  assert.doesNotMatch(parentText, /\[tabId, entries,[^\]]*historyVisibleUuids/,
    'the terminal reachability effect must not depend on History viewport');
  const source = declarations.get('timelineViewportSource'); assert.ok(source);
  const activationStart = text.indexOf('  React.useLayoutEffect(() => {\n    timelineViewportSource?.setActive(isVisible);');
  assert.ok(activationStart >= 0, 'actual viewport visibility effect');
  const activationEnd = text.indexOf('  }, [timelineViewportSource, isVisible]);', activationStart)
    + '  }, [timelineViewportSource, isVisible]);'.length;
  assert.ok(activationEnd > activationStart);
  const activation = text.slice(activationStart, activationEnd);
  const row = declarations.get('TimelineSegmentRow').initializer;
  const beginning = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'TimelineBeginningViewportMarker');
  const helpers = ast.statements.filter(n => ts.isFunctionDeclaration(n) && ['expandedPreviewCharLimit','truncateTimelinePreviewText'].includes(n.name?.text)
    || ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(ast).startsWith('EXPANDED_PREVIEW_')));
  // Execute the exact JSX/map body and actual memo row. Only add counters at
  // function entry; parent infrastructure unrelated to viewport is controlled.
  const callback = row.arguments[0];
  const instrumentedRow = callback.getText(ast).replace(/\)\s*\{/, ') { probeRow(index);');
  const code = `const {useMemo} = React;
    ${helpers.map(n => n.getText(ast)).join('\n')}
    const TimelineSegmentRow = React.memo(${instrumentedRow});
    ${beginning.getText(ast)}
    function Frame({entries,tabId,sessionId,timelineOwnerKey=JSON.stringify([tabId,sessionId]),isVisible=true,historyTargetVisible=true,isSdkTab=false}) {
      probeParent();
      const visibleEntryIndices = legacyVisible;
      const ${source.getText(ast)};
      ${activation}
      return <div>${'{'}${map.getText(ast)}}
        <TimelineBeginningViewportMarker viewportSource={timelineViewportSource} legacyInViewport={visibleEntryIndices.has(0)} kind="fork" />
        <TimelineBeginningViewportMarker viewportSource={timelineViewportSource} legacyInViewport={visibleEntryIndices.has(0)} kind="plan" />
      </div>;
    }
    ({Frame, TimelineSegmentRow, TimelineBeginningViewportMarker});`;
  const compiled = ts.transpileModule(code, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
  // Differential control: restore only the old parent selector. This is a
  // conservative reconstruction of that cost, not a claim to run installed110.
  const preCode = code.replace('const ' + source.getText(ast) + ';',
    'const historyVisibleUuids = useUIStore(state => state.historyVisibleUuids[tabId]); const timelineViewportSource = undefined;');
  assert.notEqual(preCode, code);
  const preCompiled = ts.transpileModule(preCode, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
  const result = spawnSync(process.execPath, ['--max-old-space-size=64', new URL('./timelineViewport.actual.fixture.mjs', import.meta.url).pathname], {
    input: JSON.stringify({ compiled, preCompiled }), encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 45000,
    env: { ...process.env, NODE_ENV: 'production' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  console.log(result.stdout.trim());
});
