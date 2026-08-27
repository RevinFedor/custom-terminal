import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const terminalArea = fs.readFileSync(path.join(here, 'TerminalArea.tsx'), 'utf8');
const paneSurface = fs.readFileSync(path.join(here, 'SplitPaneSurface.tsx'), 'utf8');
const history = fs.readFileSync(path.join(here, 'HistoryPanel.tsx'), 'utf8');

test('workflow switch reuses exact persistent tab elements and projects presentation imperatively', () => {
  assert.match(terminalArea, /const PersistentPaneTabLayerHost = memo/);
  assert.match(terminalArea, /<PersistentPaneTabLayerHost/);
  assert.match(terminalArea, /tabLayerNodeCacheRef/);
  assert.match(terminalArea, /paneChromeNodeCacheRef/);
  assert.match(terminalArea, /paneChromeLayouts\.forEach/);
  assert.match(terminalArea, /const ownerKey = `\${layout\.id}:\${paneIndex}`/);
  assert.match(terminalArea, /cachedLayer\?\.structuralKey === structuralKey/);
  assert.match(terminalArea, /node=\{cachedLayer\.node\}/);
  assert.match(terminalArea, /diffPaneLayerPresentations\(previous, next\)/);
  assert.match(terminalArea, /\[Perf:TabLayerProjection\]/);
  assert.match(terminalArea, /\[Perf:PaneLayerPresentation\]/);
  assert.match(terminalArea, /changed=' \+ changedTabIds\.length/);
});

test('presentation manager preserves visibility, keyboard isolation and exact History channels', () => {
  assert.match(terminalArea, /element\.style\.opacity = model\.presented \? '1' : '0'/);
  assert.match(terminalArea, /data-pane-event-index/);
  assert.match(terminalArea, /element\.setAttribute\('data-pane-event-index'/);
  assert.match(terminalArea, /data-pane-focus-isolated/);
  assert.match(terminalArea, /element\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(terminalArea, /paneFocusIsolationRef\.current\?\.sync\(\)/);
  assert.match(terminalArea, /`split-pane:\$\{tabId\}:main`/);
  assert.match(terminalArea, /`split-pane:\$\{tabId\}:side`/);
  assert.match(terminalArea, /geometryStable: model\.geometryStable/);
});

test('cold pane can wake from external presentation without making dormant a render owner', () => {
  assert.match(paneSurface, /PANE_LAYER_PRESENTATION_EVENT/);
  assert.match(paneSurface, /if \(detail\.presented === true\) wakeForeground\('external'\)/);
  assert.match(paneSurface, /dormantSurfaceAdmission\.promote\(admissionKey\)/);
  assert.match(paneSurface, /setSurfacesAwake\(true\)/);
  assert.match(paneSurface, /externalPresentationRef\.current\.focused/);
});

test('external pane focus leases global History shortcuts without transcript rerender', () => {
  assert.match(history, /globalHotkeysSuppressedRef/);
  assert.match(history, /typeof detail\.focused === 'boolean'/);
  assert.match(history, /globalHotkeysSuppressedRef\.current = !detail\.focused/);
  assert.match(history, /if \(globalHotkeysSuppressedRef\.current\) return/);
  assert.match(history, /if \(suppressWindowEscape \|\| effectiveSuppressWindowEscapeRef\.current\) return/);
  assert.match(history, /suppressWindowEscapeRef=\{globalHotkeysSuppressedRef\}/);
});

test('pane body drop targets belong to active chrome, not cached hidden tab trees', () => {
  assert.match(terminalArea, /data-pane-tab-drop-host=\{paneIndex\}/);
  assert.match(terminalArea, /<PaneTabBodyDropZone paneIndex=\{paneIndex\}/);
  assert.doesNotMatch(terminalArea, /shownInPane \|\| \(!inPane && active\)[\s\S]{0,120}<PaneTabBodyDropZone/);
});
