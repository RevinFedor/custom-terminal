import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(
  path.join(here, '../components/Workspace/HistoryPanel.tsx'),
  'utf8',
);

test('History draft reads use the same three-valued preflight as scenario sends', () => {
  const start = source.indexOf('const readTerminalDraft = useCallback');
  const end = source.indexOf('\n  useEffect(() => {', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  assert.match(body, /classifyAgentDraftPreflight\(draftState\)/);
  assert.doesNotMatch(
    body,
    /if \(draftState\.hasDraft === false\)/,
    'a raw boolean may contradict an explicit unknown proof outcome',
  );
  assert.match(body, /claudeExactEmptyEvidence:[\s\S]*result\?\.proofOutcome === 'absent'/);
});

test('History carries exact empty evidence through the scenario to the physical paste boundary', () => {
  assert.match(source, /claudeExactEmptyEvidence = terminalDraft\.claudeExactEmptyEvidence \|\| null/);
  assert.match(source, /sendAgentPromptScenario\(\{[\s\S]{0,1000}claudeExactEmptyEvidence,/);
});

test('known unavailable image warns persistently without disabling Send', () => {
  const availabilityStart = source.indexOf('const canAcceptSubmitIntent =');
  const availabilityEnd = source.indexOf('\n  const terminalOnlySlashDraft', availabilityStart);
  assert.ok(availabilityStart >= 0 && availabilityEnd > availabilityStart);
  const availability = source.slice(availabilityStart, availabilityEnd);
  assert.match(availability, /!derivedDraftImageNotice\?\.blocking/);
  assert.doesNotMatch(availability, /!derivedDraftWarning/);

  assert.match(source, /notice=\{historyImageNoticeBanner\}/);
  assert.match(source, /data-history-image-notice/);
  assert.match(source, /persistentImageDraftNotice = derivedDraftImageNotice/);
  assert.match(source, /Send remains available; this slot will be sent as an explicit imageError/);
});

test('History send materializes known missing refs into imageError instead of returning early', () => {
  const start = source.indexOf('const prepareHistoryPromptForSend = useCallback');
  const end = source.indexOf('\n  const runAction = useCallback', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  assert.match(body, /if \(immediateNotice\?\.blocking\)/);
  assert.match(body, /buildPromptImagePayload\(text, materializedImages/);
  assert.match(body, /degraded: materializedInspection\.unavailable/);
  assert.doesNotMatch(body, /if \(state !== 'ready'\)/);
});
