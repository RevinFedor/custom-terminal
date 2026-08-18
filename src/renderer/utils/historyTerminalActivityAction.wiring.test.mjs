import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const panelPath = fileURLToPath(new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url));
const panelSource = readFileSync(panelPath, 'utf8');

test('ordinary activity click is lifecycle-only while diagnostics stay on context click', () => {
  const actionStart = panelSource.indexOf('const activateUnifiedStatus');
  const actionEnd = panelSource.indexOf('// History owns PTY state', actionStart);
  assert.ok(actionStart >= 0 && actionEnd > actionStart, 'activity action block must exist');

  const actionBlock = panelSource.slice(actionStart, actionEnd);
  assert.doesNotMatch(actionBlock, /copyStatusDetails/);
  assert.match(actionBlock, /runAction\('resume'\)/);
  assert.match(actionBlock, /runAction\(canInterruptTurn \? 'interrupt' : 'stop'\)/);

  assert.match(panelSource, /onContextMenu=\{\(event\) => \{[\s\S]*?copyStatusDetails\(\);[\s\S]*?\}\}/);
  assert.match(panelSource, /aria-disabled=\{statusPrimaryAction === 'pending'\}/);
});
