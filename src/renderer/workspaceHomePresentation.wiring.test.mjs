import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rendererDir = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(rendererDir, 'App.tsx'), 'utf8');
const store = readFileSync(join(rendererDir, 'store/useWorkspaceStore.ts'), 'utf8');

test('Home hides the persistent workspace at an ancestor boundary', () => {
  assert.match(app, /data-workspace-presentation=\{view\}/);
  assert.match(app, /aria-hidden=\{view !== 'workspace'\}/);
  assert.match(app, /inert=\{view !== 'workspace'\}/);
  assert.match(app, /opacity: view === 'workspace' \? 1 : 0/);
  assert.match(app, /pointerEvents: 'none' as const/);
});

test('Home toggles presentation without conditionally unmounting Workspace', () => {
  assert.match(app, /\{view === 'dashboard' && <Dashboard \/>\}/);
  assert.match(app, /<Workspace[\s\S]{0,400}processStatus=/);
  assert.doesNotMatch(app, /\{view === 'workspace' &&\s*<Workspace(?:\s|>)/);
  assert.match(
    app,
    /view === 'dashboard' && activeProjectId \? showWorkspace\(activeProjectId\) : showDashboard\(\)/,
  );
});

test('showDashboard preserves the active project and live sessions', () => {
  const body = store.match(/showDashboard: async \(\) => \{([\s\S]*?)\n  \},\n\n  toggleTabSelection:/)?.[1] || '';
  assert.match(body, /set\(\{ view: 'dashboard' \}\)/);
  assert.doesNotMatch(body, /activeProjectId:\s*null/);
  assert.doesNotMatch(body, /closeProject|closeTab|terminal:kill/);
});
