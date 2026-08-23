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

test('document resume reconciles durable state without inventing a Timeline invalidation', () => {
  const start = timelineSource.indexOf('const onVis = () =>');
  const end = timelineSource.indexOf("document.addEventListener('visibilitychange', onVis)", start);
  assert.ok(start >= 0 && end > start, 'Timeline visibility-resume handler must exist');
  const resume = timelineSource.slice(start, end);
  assert.match(resume, /agent-transcript:refresh/);
  assert.match(resume, /pending: deferredTranscriptRefreshRef\.current/);
  assert.doesNotMatch(
    resume,
    /invalidation:\s*true/,
    'visibility is not proof that transcript bytes changed',
  );
});

test('persistent split Timeline receives pane presentation, not whole-workspace visibility', () => {
  assert.match(splitPaneSource, /const historySurfacePresented = workspaceVisible && !dormant/);
  assert.match(splitPaneSource, /<Timeline[\s\S]*?isVisible=\{historySurfacePresented\}/);
  assert.doesNotMatch(
    splitPaneSource,
    /<Timeline[\s\S]*?isVisible=\{workspaceVisible\}/,
    'a hidden space must remain subscribed without building its projection',
  );
});
