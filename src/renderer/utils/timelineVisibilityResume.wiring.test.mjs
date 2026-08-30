import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const timelineSource = fs.readFileSync(
  path.join(repoRoot, 'src/renderer/components/Workspace/Timeline.tsx'),
  'utf8',
);
const splitPaneSource = fs.readFileSync(
  path.join(repoRoot, 'src/renderer/components/Workspace/SplitPaneSurface.tsx'),
  'utf8',
);
const persistentTimelineSource = fs.readFileSync(
  path.join(repoRoot, 'src/renderer/components/Workspace/PersistentPaneTimeline.tsx'),
  'utf8',
);
const workspaceSource = fs.readFileSync(
  path.join(repoRoot, 'src/renderer/components/Workspace/Workspace.tsx'),
  'utf8',
);

test('document resume explicitly reconciles invalidations that may be throttled while hidden', () => {
  const start = timelineSource.indexOf('const onVis = () =>');
  const end = timelineSource.indexOf("document.addEventListener('visibilitychange', onVis)", start);
  assert.ok(start >= 0 && end > start, 'Timeline visibility-resume handler must exist');
  const resume = timelineSource.slice(start, end);
  assert.match(resume, /agent-transcript:refresh/);
  assert.match(resume, /pending: deferredTranscriptRefreshRef\.current/);
  assert.match(resume, /invalidation:\s*true/);
});

test('persistent split Timeline receives pane presentation, not whole-workspace visibility', () => {
  assert.match(splitPaneSource, /const historySurfacePresented = externalPresentationRef\.current\.presented/);
  assert.match(splitPaneSource, /<PersistentPaneTimeline[\s\S]*?initialPresented=\{historySurfacePresented\}/);
  assert.match(persistentTimelineSource, /subscribePaneTimelinePresentation\(\{/);
  assert.match(persistentTimelineSource, /startTransition\(\(\) => setPresented\(nextPresented\)\)/);
  assert.doesNotMatch(persistentTimelineSource, /setTimeout|requestAnimationFrame/);
  assert.match(persistentTimelineSource, /<Timeline[\s\S]*?isVisible=\{presented\}[\s\S]*?presentationExternallyManaged/);
  assert.match(timelineSource, /const timelinePixelsVisible = presentationExternallyManaged \|\| isVisible/);
  assert.match(timelineSource, /visibility: timelinePixelsVisible \? 'inherit' : 'hidden'/);
  assert.match(timelineSource, /opacity: timelinePixelsVisible \? 1 : 0/);
  assert.match(
    workspaceSource,
    /data-single-center-timeline-retained[\s\S]*?<Timeline[\s\S]*?presentationExternallyManaged/,
    'the retained zero-pane Timeline must use its outer presentation boundary too',
  );
  assert.doesNotMatch(
    splitPaneSource,
    /<PersistentPaneTimeline[\s\S]*?(?:isVisible|initialPresented)=\{workspaceVisible\}/,
    'a hidden space must remain subscribed without building its projection',
  );
  assert.doesNotMatch(
    persistentTimelineSource,
    /from ['"]\.\/HistoryPanel['"]|<HistoryPanel|from ['"]react-virtuoso['"]|getBoundingClientRect|querySelector/,
    'the reactive visibility boundary must not touch History identity or layout',
  );
  assert.match(
    splitPaneSource,
    /\{showTimeline && timelineHeavyAwake && \([\s\S]*?<PersistentPaneTimeline/,
    'presentation hide must not be a Timeline mount condition',
  );

  const unsubscribeAt = timelineSource.indexOf(
    "ipcRenderer.invoke('agent-transcript:unsubscribe', { consumerId })",
  );
  const dependencyStart = timelineSource.indexOf('}, [', unsubscribeAt);
  const dependencyEnd = timelineSource.indexOf(']);', dependencyStart);
  assert.ok(unsubscribeAt >= 0 && dependencyStart > unsubscribeAt && dependencyEnd > dependencyStart);
  const transcriptSubscriptionDependencies = timelineSource.slice(dependencyStart, dependencyEnd);
  assert.doesNotMatch(
    transcriptSubscriptionDependencies,
    /isVisible/,
    'show/hide updates Timeline props without unsubscribe/remount',
  );
});
