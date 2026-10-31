import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import MagicString from 'magic-string';
import remapping from '@jridgewell/remapping';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { historyVirtuosoMeasurementVitePlugin, patchHistoryVirtuoso } from './history-virtuoso-measurement.mjs';
import { styleModSameRulesVitePlugin, patchStyleModSameRules } from './style-mod-same-rules.mjs';
import { mappedReplacements, perfBuildProvenancePlugin } from './perf-build-provenance.mjs';

function position(text, index) {
  const lines = text.slice(0, index).split('\n');
  return { line: lines.length, column: lines.at(-1).length };
}
function check(source, id, plugin, patch, inserted, original) {
  const result = plugin.transform(source, id);
  assert.equal(result.code, patch(source));
  assert.ok(!result.map.sourcesContent || result.map.sourcesContent.every(x => x == null));
  const index = result.code.lastIndexOf(original);
  const sourceIndex = source.lastIndexOf(original);
  assert.ok(index >= 0 && sourceIndex >= 0);
  const originalPos = position(source, sourceIndex);
  const map = new TraceMap(result.map);
  const actual = originalPositionFor(map, position(result.code, index));
  assert.equal(actual.line, originalPos.line);
  assert.equal(actual.column, originalPos.column);
  const added = result.code.indexOf(inserted);
  assert.ok(added >= 0);
  assert.ok(index > added, 'original location must follow the inserted code');
  assert.equal(originalPositionFor(map, position(result.code, added)).source, null);
  const earlier = new MagicString('\n' + source);
  earlier.remove(0, 1);
  const prior = earlier.generateMap({ source: 'prior.js', hires: true });
  const composed = new TraceMap(remapping([result.map, prior], () => null));
  assert.equal(originalPositionFor(composed, position(result.code, index)).line, originalPos.line + 1);
  assert.equal(originalPositionFor(composed, position(result.code, added)).source, null);
}

test('real pinned transforms map unchanged locations through composition and mark inserted tokens unknown', () => {
  const virtuoso = readFileSync(new URL('../../node_modules/react-virtuoso/dist/index.mjs', import.meta.url), 'utf8');
  const style = readFileSync(new URL('../../node_modules/style-mod/src/style-mod.js', import.meta.url), 'utf8');
  check(virtuoso, '/node_modules/react-virtuoso/dist/index.mjs', historyVirtuosoMeasurementVitePlugin(), patchHistoryVirtuoso, 'historyPrimaryRenderTransaction', 'export {');
  check(style, '/node_modules/style-mod/src/style-mod.js', styleModSameRulesVitePlugin(), patchStyleModSameRules, 'noted:style-mod-same-rules', 'setNonce(nonce)');
});

test('same-line insert and following original have explicit distinct mappings', () => {
  const { code, map } = mappedReplacements('abcDEFghi', [['DEF', 'HELLO']], 'x.js');
  const trace = new TraceMap(map);
  assert.equal(code, 'abcHELLOghi');
  assert.equal(originalPositionFor(trace, { line: 1, column: 5 }).source, null);
  assert.equal(originalPositionFor(trace, { line: 1, column: 8 }).column, 6);
});

test('manifest hashes only emitted bundle bytes and distinguishes build from runtime engine', () => {
  let receipt;
  const plugin = perfBuildProvenancePlugin('renderer');
  plugin.generateBundle.handler.call({ emitFile: file => { receipt = file; } }, {}, {
    'app.js': { type: 'chunk', code: 'code' },
    'app.js.map': { type: 'asset', source: '{"version":3}' },
  });
  const data = JSON.parse(receipt.source);
  assert.equal(data.runtimeEngine, null);
  assert.equal(data.files[0].sha256, createHash('sha256').update('code').digest('hex'));
  assert.equal(data.files[1].sha256, createHash('sha256').update('{"version":3}').digest('hex'));
  assert.equal(data.files.length, 2);
});
