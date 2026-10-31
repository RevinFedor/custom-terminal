import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { installInspectorPrivateSourcemap, patchInspectorCore } from './inspector-private-sourcemap.mjs';

const require = createRequire(import.meta.url);
const { TraceMap, originalPositionFor } = require('@jridgewell/trace-mapping');
const out = mkdtempSync(join(tmpdir(), 'noted-inspector-map-'));
test.after(() => rmSync(out, { recursive: true }));
const corePath = join(dirname(require.resolve('@code-inspector/core')), 'index.mjs');
const url = pathToFileURL(corePath).href;
const original = await import(url);
const hook = installInspectorPrivateSourcemap(corePath);
const patched = await import(url + '?private-map-test');
hook.deregister();
assert.equal(hook.receipt.loaded, 1);
writeFileSync(join(out, 'receipt.json'), JSON.stringify(hook.receipt, null, 2));
function pos(code, index) {
  const pre = code.slice(0, index), lines = pre.split('\n');
  return { line: lines.length, column: lines.at(-1).length };
}
async function compare(file, content, needles) {
  const args = { content, filePath: file, fileType: 'jsx', pathType: 'relative' };
  const before = await original.transformCode(args);
  const after = await patched.transformCode(args);
  assert.equal(typeof before, 'string');
  assert.equal(after.code, before);
  if (after.map === null) {
    assert.equal(after.code, content, 'only unchanged bytes may preserve the preceding map');
    return { bytes: content.length, generatedBytes: after.code.length, unchanged: true };
  }
  assert.equal(after.map.sources[0], file);
  const trace = new TraceMap(after.map);
  for (const needle of needles) {
    const src = content.indexOf(needle), generated = after.code.indexOf(needle);
    assert.ok(src >= 0 && generated >= 0, needle);
    const expected = pos(content, src), actual = originalPositionFor(trace, pos(after.code, generated));
    assert.equal(actual.line, expected.line, needle);
    assert.ok(actual.column <= expected.column, 'line map may resolve to a preceding source column');
    assert.equal(actual.source, file);
  }
  for (const insertion of ['data-insp-path=', '__codeInspectorPath']) {
    const idx = after.code.indexOf(insertion);
    if (idx !== -1) assert.equal(originalPositionFor(trace, pos(after.code, idx)).source, null, `${insertion} must be unmapped`);
  }
  return { bytes: content.length, generatedBytes: after.code.length, mappedNeedles: needles };
}
test('real core: TSX, pure mjs, current HistoryPanel and unsupported hash', async () => {
  assert.throws(() => patchInspectorCore('unsupported'), /Unsupported/);
  const fixture = join(out, 'fixture.tsx');
  const content = `import React from 'react';\nexport function Demo({title}: {title: string}) { return <section><span>{title}</span><Widget label={title} /></section>; }\n`;
  writeFileSync(fixture, content);
  const mjs = join(out, 'fixture.mjs');
  const js = 'export function calculate(value) { return value + 17; }\n';
  writeFileSync(mjs, js);
  const results = [];
  results.push(await compare(fixture, content, ['title}</span>', 'label={title}', 'Widget']));
  results.push(await compare(mjs, js, ['calculate', 'value + 17']));
  const history = resolve('src/renderer/components/Workspace/HistoryPanel.tsx');
  const source = readFileSync(history, 'utf8');
  assert.ok(source.length < 2_000_000);
  results.push(await compare(history, source, ['history.displayUnits']));
  for (const [relative, needle] of [
    ['src/renderer/utils/historyReadTransport.mjs', 'history.decode'],
    ['src/renderer/utils/paneFocusIsolation.ts', 'pane.focusDeferred'],
    ['src/renderer/components/Workspace/TerminalArea.tsx', 'pane.presentationLayout'],
  ]) {
    const file = resolve(relative);
    results.push(await compare(file, readFileSync(file, 'utf8'), [needle]));
  }
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
});

test('entry injection is preserved byte for byte and gets no misleading map', async () => {
  const file = join(out, 'entry.tsx');
  const content = 'export const Entry = () => <div>entry</div>;\n';
  writeFileSync(file, content);
  const options = { server: 'close', importClient: 'code' };
  const inject = core => core.getCodeWithWebComponent({ options, record: { output: out }, file, code: content, inject: true });
  const a = await inject(original), b = await inject(patched);
  assert.equal(a, b);
  assert.notEqual(a, content);
  const args = { content: a, filePath: file, fileType: 'jsx' };
  const oldResult = await original.transformCode(args);
  const newResult = await patched.transformCode(args);
  assert.equal(typeof newResult, 'string');
  assert.equal(newResult, oldResult);
});
