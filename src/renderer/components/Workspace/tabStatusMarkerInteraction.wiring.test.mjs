import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workspaceDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(workspaceDir, 'TabSignals.tsx'), 'utf8');
const start = source.indexOf('export function TabStatusMarkerButton(');
const end = source.indexOf('/**\n * Заполнение контекстного окна', start);
const marker = source.slice(start, end);

test('clickable status square shares task-marker hover acknowledgement', () => {
  assert.match(source, /const TAB_MARKER_HOVER_SCALE = 1\.32/);
  assert.match(source, /export const TASK_MARKER_HOVER_SCALE = TAB_MARKER_HOVER_SCALE/);
  assert.match(marker, /onMouseEnter=\{\(\) => setMarkerHovered\(true\)\}/);
  assert.match(marker, /translateY\(-50%\) scale\(\$\{markerHovered \? TAB_MARKER_HOVER_SCALE : 1\}\)/);
  assert.match(marker, /filter: markerHovered \? 'brightness\(1\.18\)' : 'none'/);
});

test('status menu closes from capture even when an outside input stops bubbling', () => {
  assert.match(marker, /window\.addEventListener\('pointerdown', closeOutside, true\)/);
  assert.match(marker, /window\.removeEventListener\('pointerdown', closeOutside, true\)/);
  assert.match(marker, /menuRef\.current\?\.contains\(target\) \|\| markerRef\.current\?\.contains\(target\)/);
  assert.match(marker, /ref=\{menuRef\}[\s\S]*data-tab-status-marker-menu/);
});
