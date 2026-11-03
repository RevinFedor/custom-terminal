'use strict';
// Claude writes its own terminal notices into the transcript as
// `{type:'system', subtype:'informational', content}` — the idle auto-compact
// line is one of them:
//   "Compacted while idle, before the prompt cache expired · turn off with
//    \"idleCompaction\": false in settings.json"
// They are part of the conversation (they explain a compact the user never
// asked for), and the user sees them in the TUI, but History dropped them:
// the session showed COMPACTED with nothing saying why. Live records:
// session be82a19d lines 1806 (12:11:57) and 5937 (19:33:47), both chained
// through parentUuid, both missing from History.
//
// Asserts the REAL projection branch in ipc/claude-data.js and the REAL
// renderer row, not a copy of them.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const dataSource = fs.readFileSync(path.join(__dirname, 'ipc', 'claude-data.js'), 'utf8');
const panelSource = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'components', 'Workspace', 'HistoryPanel.tsx'), 'utf8',
);

const NOTICE = 'Compacted while idle, before the prompt cache expired'
  + ' · turn off with "idleCompaction": false in settings.json';

// Run the exact branch from claude-data.js over the exact record shape.
function projectBranch(entry) {
  const marker = "} else if (entry.type === 'system' && entry.subtype === 'informational'";
  const start = dataSource.indexOf(marker, dataSource.indexOf('const historyBranch ='));
  assert.ok(start > 0, 'informational branch exists in the History projection');
  const end = dataSource.indexOf("} else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {", start);
  assert.ok(end > start);
  // The slice starts at `} else if (...) {`; close the synthetic opener before
  // it and the branch body after it.
  const body = 'if (false) {' + dataSource.slice(start, end) + '}';
  const projected = [];
  const ctx = vm.createContext({
    entry,
    entrySid: 'be82a19d-4a26-4263-b32a-e91477e1cd17',
    appendProjectedEntry: (value) => projected.push(value),
  });
  vm.runInContext(body, ctx);
  return projected;
}

test('the idle auto-compact notice becomes a History row with its exact text', () => {
  const rows = projectBranch({
    type: 'system',
    subtype: 'informational',
    uuid: '0f4f9791-0000-4000-8000-000000000000',
    timestamp: '2026-11-01T12:11:57.000Z',
    content: NOTICE,
    __byteOffset: 4242,
    isMeta: false,
  });
  assert.equal(rows.length, 1, 'pre-fix this record produced no row at all');
  assert.equal(rows[0].role, 'informational');
  // Exactly as Claude printed it — no rewording, no summary.
  assert.equal(rows[0].content, NOTICE);
  assert.equal(rows[0].uuid, '0f4f9791-0000-4000-8000-000000000000');
  assert.equal(rows[0].timestamp, '2026-11-01T12:11:57.000Z');
  assert.equal(rows[0].recordByteOffset, 4242);
});

test('an empty or non-string notice produces nothing', () => {
  assert.deepEqual(projectBranch({ type: 'system', subtype: 'informational', content: '   ' }), []);
  assert.deepEqual(projectBranch({ type: 'system', subtype: 'informational', content: null }), []);
  assert.deepEqual(projectBranch({ type: 'system', subtype: 'informational' }), []);
});

// The notice is service chrome, so it must speak in the SAME voice as the
// other service lines of this feed — an interrupted turn, a usage limit —
// not in a shape of its own. A labelled `MessageEvent` card was exactly that
// foreign shape and the user rejected it on sight (01.11).
test('the notice reuses the interrupted/usage-limit service row, not a card', () => {
  const start = panelSource.indexOf("if (entry.role === 'informational')");
  assert.ok(start > 0, 'the renderer handles the informational role');
  // Only this branch, up to its closing brace — the next role starts there.
  const body = panelSource.slice(start, panelSource.indexOf('\n  }\n', start));
  assert.match(body, /return <HistoryInterruptedRow entry=\{entry\} \/>;/,
    'the same component as interrupted and usage-limit rows');
  assert.doesNotMatch(body, /MessageEvent/, 'no labelled banner for a service line');
  // That shared row prints entry.content verbatim — exact wording, no rewrite.
  const row = panelSource.slice(panelSource.indexOf('const HistoryInterruptedRow'));
  assert.match(row.slice(0, 700), /\{entry\.content\}/);
  // And it must take the amber channel, like a usage limit, not the raspberry
  // one that means "the provider cut this turn off".
  assert.match(row.slice(0, 700),
    /entry\.role === 'informational'[\s\S]{0,60}hp-history-provider-error/,
    'amber service channel');
  assert.match(panelSource, /\.hp-history-provider-error \{ color: #b87946; \}/);
  // COMPACTED stays its own row: the notice explains it, it does not replace it.
  assert.match(panelSource, /if \(entry\.role === 'compact'\) \{\s*\n\s*return <CompactBlock/);
  assert.match(panelSource, /\| 'informational';/, 'the role is part of the entry type');
});
