import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(here, '..');
const app = fs.readFileSync(path.join(rendererDir, 'App.tsx'), 'utf8');
const runner = fs.readFileSync(path.join(here, 'runWorkflowIconHierarchyMigration.ts'), 'utf8');
const catalog = fs.readFileSync(path.join(here, 'workflowIconCatalog.ts'), 'utf8');
const strip = fs.readFileSync(path.join(rendererDir, 'components', 'Workspace', 'SpaceStrip.tsx'), 'utf8');
const globals = fs.readFileSync(path.join(rendererDir, 'styles', 'globals.css'), 'utf8');
const assetsDir = path.join(rendererDir, 'assets', 'workflow-icons');

test('production migration runs only after projects and session are live', () => {
  const load = app.indexOf('await loadProjects();');
  const restore = app.indexOf('await restoreSession();', load);
  const migrate = app.indexOf('await runWorkflowIconHierarchyMigration();', restore);
  assert.ok(load >= 0 && restore > load && migrate > restore);
  assert.match(runner, /if \(!import\.meta\.env\.PROD\) return/);
});

test('migration mutates live stores, persists one canonical snapshot, then verifies', () => {
  assert.match(runner, /updateWorkspaceSpaceMetadata\(update\.id/);
  assert.match(runner, /await useProjectsStore\.getState\(\)\.updateProject\(update\.id, \{ icon: update\.icon \}\)/);
  assert.match(runner, /const snapshot = buildSessionSnapshot\(useWorkspaceStore\.getState\(\)\)/);
  assert.match(runner, /await ipcRenderer\.invoke\('app:setState', \{ key: SESSION_KEY, value: snapshot \}\)/);
  const verifyAt = runner.indexOf("const persistedSession = await ipcRenderer.invoke('app:getState', SESSION_KEY)");
  const markerAt = runner.lastIndexOf("key: WORKFLOW_ICON_HIERARCHY_MIGRATION_KEY");
  assert.ok(verifyAt > 0 && markerAt > verifyAt, 'marker is written only after reread verification');
  assert.doesNotMatch(runner, /sqlite|noted-terminal\.db/i);
  assert.match(app, /WorkflowIconMigration\] failed detail=/,
    'production log must preserve Error.message instead of serializing Error as {}');
  assert.match(runner, /actualProjects=\$\{JSON\.stringify/,
    'space verification must identify the exact persisted mismatch');
});

test('workflow and project use exact pre-migration PNG; grayscale is reversible display style', () => {
  const originalDir = path.join(assetsDir, 'original');
  const originals = fs.readdirSync(originalDir).filter((name) => name.endsWith('.b64'));
  assert.equal(originals.length, 7);
  assert.match(catalog, /workflowIcon: pngDataUrl/);
  assert.match(catalog, /projectIcon: pngDataUrl/);
  assert.match(app, /data-project-icon=\{projectId\}/);
  assert.match(strip, /data-workflow-icon=\{id\}/);
  assert.match(globals, /data-project-icons-grayscale='true'[\s\S]{0,120}data-project-icon/);
  assert.doesNotMatch(strip, /data-project-icon/);
});

test('migration creates missing GT/Mac workflows through the live store', () => {
  assert.match(catalog, /canonicalWorkflowName: 'gt-editor'[\s\S]{0,80}ensureWorkflow: true/);
  assert.match(catalog, /canonicalWorkflowName: 'mac-electron'[\s\S]{0,80}ensureWorkflow: true/);
  assert.match(runner, /addWorkspaceSpace\(\{[\s\S]{0,120}activate: false/);
  assert.match(runner, /createdSpaces\.push/);
});
