import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
const panel=fs.readFileSync(new URL('../components/Workspace/HistoryPanel.tsx',import.meta.url),'utf8');
const shared=fs.readFileSync(new URL('../components/Workspace/HistoryTranscriptPresentation.tsx',import.meta.url),'utf8');

test('caption click stays inside the existing reveal/reading and raw-UUID hydration owner',()=>{
  const start=panel.indexOf('const cycleHistoryGroupCaption ='),end=panel.indexOf('// Latest entries length',start),code=panel.slice(start,end);
  assert.ok(start>=0&&end>start);
  assert.match(code,/historyOwnerKeyRef\.current !== historyOwnerKey/);
  assert.match(code,/!historyPresentationProofRef\.current\.presented/);
  assert.match(code,/applyHistoryRevealUpdate\(anchor, false, commit\)/);
  assert.match(code,/requestHistoryHydrationAt\(next\.uuid, 'group-caption'\)/);
  assert.match(code,/uiPerformancePhase\('history-group-caption-cycle'/);
  assert.doesNotMatch(code,/\.scrollTop\s*=|scrollToIndex|setExpandedGroupKeys|setInterval|setTimeout|\.content/);
});

test('caption choice is owner-scoped bounded metadata, not a new body cache',()=>{
  assert.match(panel,/groupCaptionOwnerRef\.current !== historyOwnerKey/);
  assert.match(panel,/groupCaptionSelectionsRef\.current\.clear\(\)/);
  assert.match(panel,/captionOwnerKey=\{historyOwnerKey\}/);
  assert.match(panel,/captionSelections: groupCaptionSelectionsRef\.current/);
  assert.match(panel,/found\.caption === true \? stubEntry\.uuid : historyHydrationCenterForRange/);
});

test('one English-labelled number cycles separately from the group disclosure and dates follow the chosen text',()=>{
  assert.match(shared,/className="hp-history-caption-number"/);
  assert.match(shared,/Click for previous text/);
  assert.match(shared,/event\.preventDefault\(\); event\.stopPropagation\(\)/);
  assert.match(shared,/historyRecordTimeAttributes\(captionEntry\?\.recordTime/);
  assert.match(shared,/captionPending \? 'Loading text…'/);
  assert.doesNotMatch(shared,/onDoubleClick=/);
});
