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
});

test('manual color and grayscale sources are separate SVGs, not a CSS filter', () => {
  const svgFiles = fs.readdirSync(assetsDir).filter((name) => name.endsWith('.svg'));
  assert.equal(svgFiles.length, 14);
  for (const family of ['noted-terminal', 'gt-editor', 'agrofield', 'sc-desktop', 'flow-tab', 'voice-record', 'ios-dev']) {
    assert.ok(svgFiles.includes(`${family}-color.svg`));
    assert.ok(svgFiles.includes(`${family}-project.svg`));
  }
  assert.match(catalog, /workflowIcon: svgDataUrl/);
  assert.match(catalog, /projectIcon: svgDataUrl/);
  assert.match(app, /data-project-icon=\{projectId\}/);
  assert.match(strip, /data-workflow-icon=\{id\}/);
  assert.doesNotMatch(app, /filter:\s*['"]grayscale/);
});

