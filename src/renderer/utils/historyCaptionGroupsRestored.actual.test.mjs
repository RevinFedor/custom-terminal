import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import postcss from 'postcss';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildHistoryDisplayUnits, buildHistoryDisplayUnitsAppended,
  buildHistoryDisplayUnitsCached, resolveHistoryDisplayTarget } from './historyDisplayUnits.mjs';
import { HistoryPrimaryRootReadModel } from './historyPrimaryRootReadModel.mjs';

// Finite SOURCE checks: the real panel's three option expressions, production
// grouping/header/Markdown and actual paged reader. No app, GUI, provider or
// user transcript. Only parsed input and the in-process IPC bridge are fixtures.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const panel = fs.readFileSync(root + 'src/renderer/components/Workspace/HistoryPanel.tsx', 'utf8');
const expressionAfter = (anchor, pattern) => {
  const start = panel.indexOf(anchor);
  assert.ok(start >= 0, anchor);
  const expression = panel.slice(start).match(pattern)?.[1];
  assert.ok(expression, anchor + ' options');
  return new Function('historyGroupActionsEnabled', 'expandedGroupKeys', 'return (' + expression + ');');
};
const optionReaders = {
  primary: expressionAfter('const primaryPresentation = useMemo(', /grouping:\s*(\{[^}]+\})/),
  renderer: expressionAfter('const unitOptions = {', /const unitOptions = (\{[^}]+\})/),
  baseline: expressionAfter('displayUnitsPrevRef.current = {\n    ownerKey: historyOwnerKey,', /options:\s*(\{[^}]+\})/),
};
const options = (kind = 'renderer', keys = new Set(), enabled = true) => optionReaders[kind](enabled, keys);
const bundle = buildSync({
  stdin: { contents: 'export { HistoryCollapsedGroupRow } from "./src/renderer/components/Workspace/HistoryTranscriptPresentation.tsx";',
    resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
  alias: { '@noted/claude-blocks': root + '/packages/claude-blocks/src/index.ts' },
  loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'text' }, logLevel: 'silent',
});
const loaded = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, loaded, loaded.exports);
const { HistoryCollapsedGroupRow } = loaded.exports;
const render = group => renderToStaticMarkup(React.createElement(HistoryCollapsedGroupRow,
  { group, expanded: group.expanded === true, onToggle() {} }));
const text = (uuid, content, phase = 'commentary') => ({ uuid, sessionId: 's', role: 'assistant', textPhase: phase, content });
const action = (uuid, family) => ({ uuid, sessionId: 's', role: 'assistant', content: '', actions: [{ tool: '__raw__', rawTool: {
  toolUseId: uuid + '-call', family, toolName: { read: 'Read', search: 'Search', edit: 'Edit', run: 'Bash' }[family], args: {}, result: 'ok',
} }] });
const rows = [
  { uuid: 'u', sessionId: 's', role: 'user', content: 'prompt' },
  text('c1', 'Первый **комментарий**\n\nЕщё абзац.\n```text\nliteral code\n```'),
  { ...action('r', 'read'), sourceIdentity: 'source-r', sourceIdentityAliases: ['alias-r'] }, action('s', 'search'),
  text('c2', 'Следующий комментарий'), action('e', 'edit'), action('b', 'run'),
  { ...text('final', 'Итоговый ответ', 'final_answer'),
    responseTiming: { intervalId: 7, startTs: 1000, endTs: 4000, durationMs: 3000 } },
];

test('all actual History panel callers and the append baseline select caption groups, not response work', () => {
  for (const read of Object.values(optionReaders)) {
    assert.equal(read(true, new Set()).responseWork, false);
    assert.equal(read(false, new Set()).enabled, false);
  }
});

test('actual closed headers show both separate multiline Markdown captions; final timing stays on the final', () => {
  const before = JSON.stringify(rows);
  const units = buildHistoryDisplayUnits(rows, options());
  const groups = units.filter(unit => unit.kind === 'group');
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => group.captionEntries.map(entry => entry.uuid)), [['c1'], ['c2']]);
  assert.ok(units.every(unit => unit.familyKey !== 'response-work' && !unit.responseWork));
  const html = groups.map(render);
  assert.match(html[0], /Read/); assert.match(html[0], /Search/);
  assert.match(html[0], /<strong>комментарий<\/strong>/);
  assert.match(html[0], /<p>Ещё абзац\.<\/p>/);
  assert.match(html[0], /<pre[^>]*><code[^>]*>literal code/);
  assert.match(html[0], /data-history-caption-uuid="c1"/);
  assert.doesNotMatch(html[0], /Следующий комментарий|```|hp-history-work-preview|hp-history-response-work-head/);
  assert.match(html[1], /Следующий комментарий/); assert.match(html[1], /Edit/); assert.match(html[1], /Bash/);
  const final = units.find(unit => unit.entry?.uuid === 'final');
  assert.ok(final); assert.notEqual(final.suppressResponseTiming, true);
  assert.equal(final.entry.responseTiming.durationMs, 3000);
  assert.equal(JSON.stringify(rows), before, 'source and copy content are never rewritten');
});

test('caption typography is 90 percent and wrapping, while composer status stays 82 percent', () => {
  const serviceRatio = Number(panel.match(/const HISTORY_SERVICE_TEXT_RATIO = ([\d.]+);/)?.[1]);
  assert.equal(serviceRatio, 0.82);
  let rule = panel.slice(panel.indexOf('.hp-history-group-detail {'), panel.indexOf('.hp-history-caption-gutter {'));
  rule = rule.replace(/\$\{(\w+)\}/g, (_, name) => {
    const value = panel.match(new RegExp('const ' + name + ' = ([\\d.]+);'))?.[1];
    assert.ok(value, name); return value;
  });
  const css = postcss.parse(rule), values = new Map();
  css.walkDecls(decl => values.set(decl.prop, decl.value));
  assert.equal(values.get('font-size'), '0.9em');
  assert.equal(values.get('color'), '#8f8d88');
  assert.equal(values.get('overflow-wrap'), 'anywhere');
  assert.doesNotMatch(rule, /line-clamp|nowrap|text-overflow|max-height/);
  assert.match(panel, /\.hp-history-caption-text \{[^}]*white-space: pre-wrap;/);
});

test('caption append keeps the manually opened group and source navigation without outer work carriers', () => {
  // The incremental path requires a reusable prefix of at least eight rows;
  // below that existing guard the production code intentionally rebuilds all.
  const base = [...Array.from({ length: 12 }, (_, i) => ({ uuid: 'prior-' + i, role: 'user', content: 'prior' })), ...rows.slice(0, 4)];
  const initial = buildHistoryDisplayUnits(base, options());
  const first = initial.find(unit => unit.kind === 'group');
  const openOptions = options('renderer', new Set([first.key]));
  const opened = buildHistoryDisplayUnits(base, openOptions);
  const next = [...base, ...rows.slice(4)];
  const appended = buildHistoryDisplayUnitsAppended(base, opened, next, openOptions,
    options('baseline', new Set([first.key])));
  assert.ok(appended);
  assert.deepEqual(appended.units, buildHistoryDisplayUnits(next, openOptions));
  assert.equal(appended.units.find(unit => unit.key === first.key).expanded, true);
  assert.ok(appended.units.some(unit => unit.entry?.uuid === 'c1'));
  const second = appended.units.find(unit => unit.kind === 'group' && unit.key !== first.key);
  assert.deepEqual(second.captionEntries.map(entry => entry.uuid), ['c2']);
  const target = resolveHistoryDisplayTarget(appended.units, 'e');
  assert.equal(target.groupKey, second.key);
  const oldWork = buildHistoryDisplayUnitsCached(rows, { ...options(), responseWork: true });
  const restored = buildHistoryDisplayUnitsCached(rows, options());
  assert.notEqual(restored, oldWork, 'old response-work cache does not satisfy restored grammar');
  assert.equal(restored.filter(unit => unit.kind === 'group').length, 2);
});

test('actual primary reader uses the same caption grammar and exact UUID/call/alias through reopen', async () => {
  globalThis.window = { require };
  const { createPrimaryAddressFixture } = require('../../../scripts/test-support/history-primary-address-fixture.cjs');
  const fixture = await createPrimaryAddressFixture(null, { entries: rows });
  const model = new HistoryPrimaryRootReadModel(fixture.invoke, fixture.transport);
  model.windowDiagnostic = () => {};
  const presentation = keys => ({ localEntries: [], liveEntries: [], liveToolResults: [], rewindPreview: null,
    grouping: options('primary', new Set(keys)), captionSelections: [], settingsPresentationKeys: [] });
  const scope = { ownerKey: 'caption-restoration-fixture', generation: 1, visit: 1, presented: true };
  try {
    await model.open({ ...fixture.payload, primaryPresentation: presentation([]) }, { presentationScope: scope });
    await model.readWindow(0, model.totalCount - 1);
    const units = [...model.window.values()], groups = units.filter(unit => unit.kind === 'group');
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map(group => group.captionEntry.uuid), ['c1', 'c2']);
    for (const group of groups) {
      assert.equal(group.captionEntry.content, rows.find(entry => entry.uuid === group.captionEntry.uuid).content);
      assert.equal(group.captionEntry.captionTextComplete, true);
      assert.ok(group.entries.every(entry => entry.rowStub && !entry.content));
      assert.match(render(group), /hp-history-group-detail/);
    }
    assert.ok(units.every(unit => unit.familyKey !== 'response-work' && !unit.responseWork));
    const final = units.find(unit => unit.entry?.uuid === 'final');
    assert.ok(final); assert.notEqual(final.suppressResponseTiming, true);
    const alias = await model.resolvePresentationTarget('alias-r');
    assert.equal(alias.entryUuid, 'r'); assert.equal(alias.groupKey, groups[0].key);
    const target = await model.resolvePresentationTarget('e', { toolUseId: 'e-call' });
    assert.equal(target.entryUuid, 'e'); assert.equal(target.groupKey, groups[1].key);
    assert.equal((await model.resolveGroup(groups[1].key)).physicalKey, groups[1].key);
    await model.open({ ...fixture.payload, primaryRequestClass: 'view',
      primaryViewOptions: presentation([groups[1].key]) }, { presentationScope: scope });
    const exact = await model.resolvePresentationTarget('e', { toolUseId: 'e-call' });
    assert.equal(exact.entryUuid, 'e'); assert.equal(exact.kind, 'entry');
    await model.readWindow(exact.index, exact.index);
    assert.equal(model.unitAt(exact.index).entry.uuid, 'e');
    assert.equal(model.addressAt(exact.index).physicalKey, 'uuid:e');
    assert.deepEqual(rows.map(entry => entry.uuid), ['u', 'c1', 'r', 's', 'c2', 'e', 'b', 'final']);
  } finally { await model.close(); fixture.close(); }
});
