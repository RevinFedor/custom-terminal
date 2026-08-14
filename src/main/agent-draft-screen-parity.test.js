const assert = require('node:assert/strict');
const test = require('node:test');
const { compareAgentDraftScreenParity } = require('./agent-draft-screen-parity');

function headless(overrides = {}) {
  return {
    available: true,
    generation: 'generation-a',
    generationOrdinal: 4,
    writeSeq: 81,
    flushedSeq: 81,
    complete: true,
    cursor: { rows: 40, cols: 100, cursorRow: 120, cursorX: 2 },
    rows: [{ row: 120, text: '❯ old text' }],
    ...overrides,
  };
}

function renderer(overrides = {}) {
  return {
    success: true,
    capturedAt: 1000,
    rendererInstanceId: 'tab:1',
    rendererGeneration: 'generation-a',
    rendererGenerationOrdinal: 4,
    rendererWriteSeq: 81,
    rendererFlushedAt: 999,
    rows: 40,
    cols: 100,
    bufferLength: 150,
    baseY: 110,
    viewportY: 110,
    cursorRow: 120,
    cursorX: 2,
    dom: { painted: true },
    lines: [{ row: 120, text: '❯ old text' }],
    ...overrides,
  };
}

test('renderer and headless snapshots are comparable only at one exact write boundary', () => {
  const parity = compareAgentDraftScreenParity(headless(), renderer());
  assert.equal(parity.comparable, true);
  assert.equal(parity.visibleComparable, true);
  assert.equal(parity.sameGeometry, true);
  assert.equal(parity.sameCursor, true);
  assert.equal(parity.differingRows.length, 0);
});

test('a resize boundary is explicitly not comparable even when generation and write sequence match', () => {
  const parity = compareAgentDraftScreenParity(
    headless(),
    renderer({ rows: 36, cols: 88 }),
  );
  assert.equal(parity.comparable, false);
  assert.equal(parity.visibleComparable, false);
  assert.equal(parity.sameGeometry, false);
  assert.equal(parity.reason, 'renderer-headless-geometry-mismatch');
});

test('a hidden renderer remains a logical comparison but never visible evidence', () => {
  const parity = compareAgentDraftScreenParity(
    headless(),
    renderer({ dom: { painted: false, hiddenBy: 'ancestor-visibility-hidden' } }),
  );
  assert.equal(parity.comparable, true);
  assert.equal(parity.visibleComparable, false);
  assert.equal(parity.rendererPainted, false);
});

test('same-looking rows do not hide a renderer/headless generation mismatch', () => {
  const parity = compareAgentDraftScreenParity(
    headless(),
    renderer({ rendererGeneration: 'generation-b' }),
  );
  assert.equal(parity.comparable, false);
  assert.equal(parity.sameGeneration, false);
  assert.equal(parity.reason, 'renderer-headless-boundary-mismatch');
});

test('same exact boundary reports residual-cell divergence row by row', () => {
  const parity = compareAgentDraftScreenParity(
    headless(),
    renderer({ lines: [{ row: 120, text: '❯ ' }] }),
  );
  assert.equal(parity.comparable, true);
  assert.deepEqual(parity.differingRows, [{
    row: 120,
    equal: false,
    headlessText: '❯ old text',
    rendererText: '❯ ',
  }]);
});

test('missing renderer snapshot stays explicitly non-comparable', () => {
  assert.deepEqual(compareAgentDraftScreenParity(headless(), {
    success: false,
    error: 'no-visible-terminal',
  }), {
    comparable: false,
    reason: 'renderer-diagnostic-unavailable',
    rendererError: 'no-visible-terminal',
  });
});
