'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (relative) => fs.readFileSync(path.join(__dirname, relative), 'utf8');

test('History, Timeline, search and Copy share the lineage-backed virtual projector', () => {
  const service = read('session-transcript-service.js');
  assert.match(service, /_resolveCodexLineage\(sessionId, 'dehydrated'\)/);
  assert.match(service, /virtualProjected\.timelineEntries/);
  assert.match(service, /virtualProjected\.historyEntries/);
  assert.match(service, /searchHistory[\s\S]*?_projectCodexVirtual\(lineage, payload\.cwd\)/);
  assert.match(service, /copyCodexVirtualRange[\s\S]*?readRecords\(lineage\.descriptor, cwd\)/);
  assert.match(service, /exportCodexSession[\s\S]*?buildCodexCleanExport/);
  assert.doesNotMatch(service, /virtualProjected\.historyEntries\.concat|virtualProjected\.timelineEntries\.concat/);
});

test('renderer and destructive Rewind carry exact physical identity plus content revision', () => {
  const timeline = read('../renderer/components/Workspace/Timeline.tsx');
  const main = read('main.js');
  assert.match(timeline, /agent-transcript:copy-codex-range/);
  const copySession = fs.readFileSync(
    path.join(__dirname, '../renderer/utils/copySessionExport.ts'),
    'utf8',
  );
  assert.match(copySession, /agent-transcript:export-codex-session/);
  assert.match(timeline, /expectedContentRevision: exactRevision/);
  assert.match(timeline, /selectionContentRevisionRef\.current = entry\.contentRevision \|\| null/);
  assert.match(timeline, /targetEntryRef: entry\.entryRef \|\| null/);
  assert.match(timeline, /expectedContentRevision: entry\.contentRevision \|\| null/);
  assert.match(main, /resolveCodexPhysicalRow\(\{/);
  assert.match(main, /compositeTarget\.logicalUserIndex !== idx/);
  assert.match(main, /loadCodexRewindTargetPayload\(compositeTarget\)/);
  assert.match(main, /currentTarget = await transcriptService\.resolveCodexPhysicalRow/);
});

test('row-window identity stubs retain composite physical addressing', () => {
  const windowing = read('history-entry-window.js');
  assert.match(windowing, /'viewOwnerSessionId', 'physicalSessionId', 'transcriptSegmentId'/);
  assert.match(windowing, /'rawUuid', 'contentRevision', 'entryRef'/);
});
