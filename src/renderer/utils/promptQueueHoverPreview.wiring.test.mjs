import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(
  path.resolve(here, '../components/Workspace/PromptQueueOverlay.tsx'),
  'utf8',
);

test('collapsed queue count hover reuses the canonical interactive item list', () => {
  assert.match(source, /ref=\{queueCountButtonRef\}[\s\S]{0,500}openQueueHoverPreview\(\)/);
  assert.match(source, /\{\(panelOpen \|\| queueHoverPreviewVisible\) && \(/);
  assert.match(source, /data-prompt-queue-hover-preview/);
  assert.equal(
    (source.match(/data-prompt-queue-item-list/g) || []).length,
    1,
    'hover preview and expanded panel must share one canonical card list',
  );
  assert.match(source, /queueHoverPreviewVisible[\s\S]{0,5000}data-chip-action="replay"/);
  assert.match(source, /data-chip-action="remove"/);
  assert.match(source, /data-prompt-trigger-row=\{it\.id\}/);
  assert.match(source, /data-run-after-picker-menu.*data-prompt-queue-chip-menu/);
});
