import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const surface = fs.readFileSync(path.join(here, 'SplitPaneSurface.tsx'), 'utf8');
const history = fs.readFileSync(path.join(here, 'HistoryPanel.tsx'), 'utf8');
const timeline = fs.readFileSync(path.join(here, 'Timeline.tsx'), 'utf8');

test('hidden pane admission spans History load+subscribe before Timeline starts', () => {
  assert.match(surface, /requirements\.add\('history:load'\)/);
  assert.match(surface, /requirements\.add\('history:subscribe'\)/);
  assert.match(surface, /heavyActivationPhaseRef\.current = 'timeline'/);
  assert.match(surface, /const historyHeavyAwake = surfacesAwake/);
  assert.match(surface, /const timelineHeavyAwake = surfacesAwake/);
  assert.match(surface, /onInitialSourceSignal=\{handleHistoryInitialSourceSignal\}/);
  assert.match(surface, /onInitialSourceSignal=\{handleTimelineInitialSourceSignal\}/);
  assert.match(surface, /backgroundPrewarmAdmitted=\{heavyActivationPhase === 'timeline'/);
  assert.match(timeline, /const historyPresentationGateOpen = backgroundPrewarmAdmitted/);
  assert.match(surface, /completeAdmission\('initial-source-settled'\)/);
});

test('source completion is raw load/subscription proof, never visible loader state', () => {
  assert.match(history, /phase: 'load'/);
  assert.match(history, /phase: 'subscribe'/);
  assert.match(history, /loadHistory\(false\)\.then/);
  assert.match(history, /TRANSCRIPT_SUBSCRIBE[\s\S]{0,500}reportSubscribeSettled/);
  assert.doesNotMatch(surface, /visibleSurfaceLoading|surfaceLoading|loading === false/);
  assert.match(timeline, /loadTimeline\('effect'\)\.then/);
  assert.match(timeline, /phase: 'subscribe'/);
});

test('foreground bypass, unmount and bounded timeout cannot leak an admission lease', () => {
  assert.match(surface, /dormantSurfaceAdmission\.promote\(admissionKey\)/);
  assert.match(surface, /wakeForeground\('external'\)/);
  assert.match(surface, /if \(focused\) wakeForeground\('focus'\)/);
  assert.match(surface, /dormantSurfaceAdmission\.cancel\(admissionKey, 'unmount'\)/);
  assert.match(surface, /completeAdmission\('component-timeout'\)/);
  assert.match(surface, /requirements\.size === 0[\s\S]{0,100}completeAdmission\('no-heavy-source'\)/);
  assert.match(surface, /tracker\.lease\.complete\(reason\)/);
  assert.match(surface, /currentConfig\.sessionId !== signalSession/,
    'an old owner signal cannot release the current pane lease');
  assert.match(surface, /tracker\.requirements = panePrewarmRequirements\(currentConfig\)/,
    'a proven current owner reuses the same lease instead of overlapping the next pane');
});

test('persistent presentation and Virtuoso ownership contracts stay external', () => {
  assert.match(surface, /presented=\{initialPresentedRef\.current\}/);
  assert.match(surface, /preservePresentationGeometry=\{presentationGeometryStable\}/);
  assert.match(surface, /presentationExternallyManaged/);
  assert.match(surface, /presentationChannel=\{presentationChannel\}/);
  assert.doesNotMatch(surface, /setSurfacesAwake\(false\)/);
});
