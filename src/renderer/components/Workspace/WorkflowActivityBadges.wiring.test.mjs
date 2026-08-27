import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'WorkflowActivityBadges.tsx'), 'utf8');

test('workflow renders separate green active and static orange busy circles', () => {
  assert.match(source, /data-workflow-active-count/);
  assert.match(source, /rgba\(74, 222, 128/);
  assert.match(source, /data-workflow-busy-count/);
  assert.match(source, /rgba\(245, 158, 11/);
  assert.match(source, /boxShadow: 'inset 0 0 0 1\.5px #f59e0b'/);
  assert.doesNotMatch(source, /noted-shape-ring|noted-ring-sweep/);
  assert.match(source, /\{activeCount > 0 && \(/);
  assert.match(source, /\{busyCount > 0 && \(/);
});

test('completion and AskUserQuestion rings live on workflow, not project', () => {
  assert.match(source, /data-workflow-awaiting-ring/);
  assert.match(source, /className="tab-awaiting-input absolute inset-0 rounded"/);
  assert.match(source, /data-workflow-completion-ring/);
  assert.match(source, /tab-completion-notification-alert/);
  assert.match(source, /data-workflow-completion-count/);
  assert.match(source, /useTabCompletionNotificationDismissing/);
});
