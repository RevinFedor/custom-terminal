import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'WorkflowActivityBadges.tsx'), 'utf8');

test('workflow renders separate green active and orange busy circles', () => {
  assert.match(source, /data-workflow-active-count/);
  assert.match(source, /rgba\(74, 222, 128/);
  assert.match(source, /data-workflow-busy-count/);
  assert.match(source, /rgba\(245, 158, 11/);
  assert.match(source, /'--noted-ring-color': '#f59e0b'/);
  assert.match(source, /\{activeCount > 0 && \(/);
  assert.match(source, /\{busyCount > 0 && \(/);
});
