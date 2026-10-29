// Exact-source preservation controls, not behavioural/native acceptance and
// not a geometry certificate. These pin all old layout get/save call contexts,
// old arrays/restore/mount-wave/Timeline membership and unrelated coauthor code.
// Full preimage files need not be shipped: expected hashes come from pinned
// CURRENT input; the test reads only the patched repository's own files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getHeapStatistics } from 'node:v8';
const pins = JSON.parse(readFileSync(new URL('./test-support/history-agent-catalog-preservation-pins.json', import.meta.url), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const panel = read(pins.seed.path).toString('utf8');
assert(getHeapStatistics().heap_size_limit <= 80 * 1024 ** 2, 'runtime64/2 static source controls');
function pinned(value, pin) {
  assert.equal(Buffer.byteLength(value), pin.bytes, (pin.path || pin.name || pin.token) + ' bytes');
  assert.equal(hash(value), pin.sha256, (pin.path || pin.name || pin.token) + ' exact preimage bytes');
}
test('Timeline overlay32, measured layout/baselines and native display-unit/grouping implementations are unchanged exact files', () => {
  for (const pin of pins.files) pinned(read(pin.path), pin);
  const timeline = read('src/renderer/components/Workspace/Timeline.tsx').toString('utf8');
  assert(timeline.includes("width: slideIn ? '32px' : '0px'"));
  assert(timeline.includes("position: isExpandedLayout ? 'absolute' : 'static'"));
});
test('Research visibility/full inventory, work:v2 physical keys, full layout keys, restore/mount waves and Timeline memberships preserve original blocks', () => {
  for (const pin of pins.blocks) {
    const start = panel.indexOf(pin.first), end = panel.indexOf(pin.last, start + pin.first.length);
    assert(start >= 0 && end > start && panel.indexOf(pin.first, start + pin.first.length) === -1);
    pinned(panel.slice(start, end), pin);
  }
});
test('all five old save writers and the old geometry getter keep exact 4KiB-before/1KiB-after source guards', () => {
  for (const pin of pins.writers) {
    const positions = []; let at = 0;
    for (;;) { const next = panel.indexOf(pin.token, at); if (next < 0) break; positions.push(next); at = next + pin.token.length; }
    assert.equal(positions.length, pin.count, pin.token + ' complete caller inventory');
    const position = positions[pin.occurrence]; pinned(panel.slice(position - pin.before, position + pin.after), pin);
  }
});
test('primary agent branch cannot fall through to full historical collector/key inventory; legacy branch stays explicit', () => {
  assert(panel.includes('() => (primaryPhysicalCandidate ? EMPTY_HISTORY_ENTRIES : chipLiveEntries.length === 0'));
  assert(panel.includes('() => primaryPhysicalCandidate ? primaryAgentCurrentFace.chips : (chipsOwnerSettled'));
  const faceStart = panel.indexOf('  const primaryAgentCurrentFace = (() => {');
  const faceEnd = panel.indexOf('  const primaryAgentCatalogCurrentSnapshot =', faceStart);
  assert(faceStart >= 0 && faceEnd > faceStart);
  const face = panel.slice(faceStart, faceEnd);
  assert(face.includes('buildHistoryLivePresentation(input.rows as FullHistoryEntry[],\n        input.live)'));
  assert(face.includes('collectHistoryAgentChips(currentChipSourceEntries, chips, context.terminalFacts)'));
  assert(!face.includes('collectHistoryAgentChips(chipSourceEntries'));
  assert(!face.includes('displayEntries') && !face.includes('metadata.entries'));
  assert(panel.includes('() => (!primaryPhysicalCandidate && chipsOwnerSettled\n      ? collectHistoryAgentChips('));
  assert(panel.includes('const availableDetailKeys = useMemo(() => primaryPhysicalCandidate ? null : new Set(['));
  const begin = panel.indexOf('  useLayoutEffect(() => {\n    if (!primaryPhysicalCandidate) return;\n    const input = primaryAgentCatalogInputs;');
  const end = panel.indexOf('  // `transcriptEntries` already committed', begin);
  const effect = panel.slice(begin, end);
  assert(!effect.includes('primaryRootRef')); assert(!effect.includes('displayEntries'));
  assert(effect.includes('recipe: { segments: input.source?.segments || [], live: input.live }'));
});
console.log('V53_PRESERVED_SOURCE_PINS ' + JSON.stringify({ seed: pins.seed, currentPanelSHA256: hash(panel),
  filePins: pins.files.length, exactBlocks: pins.blocks.length, layoutCallContexts: pins.writers.length,
  qualification: 'unchanged source bytes; geometry/Timeline/full Research remain OPEN, no layout certificate or native execution' }));
