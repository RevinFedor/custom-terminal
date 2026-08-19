import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const timeline = fs.readFileSync(
  path.resolve(here, '../components/Workspace/Timeline.tsx'),
  'utf8',
);
const history = fs.readFileSync(
  path.resolve(here, '../components/Workspace/HistoryPanel.tsx'),
  'utf8',
);

test('Timeline captures exact SENT handoffs without bypassing the busy transcript defer', () => {
  assert.match(timeline, /subscribeHistoryPromptHandoffs\(tabId/);
  assert.match(timeline, /projectTimelineSentHandoffs\(snapshot, \{ toolType, sessionId \}\)/);
  assert.match(timeline, /mergeTimelineEntriesWithSentHandoffs\(durableEntries, sentHandoffEntries\)/);
  assert.match(timeline, /planTimelineTranscriptRefresh\(\{[\s\S]{0,220}isTurnBusy: busy/);
});

test('the light point keeps canonical actions but never starts truncated AI derivatives', () => {
  assert.match(timeline, /startUuid: entry\.uuid,[\s\S]{0,80}endUuid: entry\.uuid/);
  assert.match(timeline, /requestRewindRef\.current\(target/);
  const outline = timeline.slice(
    timeline.indexOf('const outlineEligibleUuids'),
    timeline.indexOf('const semanticGroups'),
  );
  assert.match(outline, /!entry\.isSentHandoffProjection/);
  assert.match(timeline, /eligibleEntries = entries\.filter\(\(entry\) => entry\.uuid && !entry\.isSentHandoffProjection/);
});

test('History publishes canonical UUID to the handoff before presentation ACK consumes it', () => {
  const consume = history.slice(
    history.indexOf('const consumeMaterializedPromptHandoffs'),
    history.indexOf('// Load full history'),
  );
  const adoptIndex = consume.indexOf('adoptHistoryPromptHandoffCanonicalEntry(');
  const acknowledgeIndex = consume.indexOf('acknowledgeMaterializedHistoryReceipt(');
  const consumeIndex = consume.indexOf('consumeHistoryPromptHandoff(', acknowledgeIndex);
  assert.ok(adoptIndex >= 0 && adoptIndex < acknowledgeIndex && acknowledgeIndex < consumeIndex);
});
