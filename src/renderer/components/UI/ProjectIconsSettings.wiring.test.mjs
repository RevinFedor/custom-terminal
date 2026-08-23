import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const settings = fs.readFileSync(path.join(here, 'ProjectIconsSettings.tsx'), 'utf8');
const cropper = fs.readFileSync(path.join(here, '..', 'Workspace', 'IconCropper.jsx'), 'utf8');
const app = fs.readFileSync(path.join(here, '..', '..', 'App.tsx'), 'utf8');
const uiStore = fs.readFileSync(path.join(here, '..', '..', 'store', 'useUIStore.ts'), 'utf8');
const globals = fs.readFileSync(path.join(here, '..', '..', 'styles', 'globals.css'), 'utf8');
const projectIconSurfaces = [
  app,
  settings,
  fs.readFileSync(path.join(here, '..', 'Dashboard', 'ProjectCard.tsx'), 'utf8'),
  fs.readFileSync(path.join(here, '..', 'Workspace', 'PaneTabStrip.tsx'), 'utf8'),
  fs.readFileSync(path.join(here, '..', 'Workspace', 'WorkflowSwitcherOverlay.tsx'), 'utf8'),
  fs.readFileSync(path.join(here, '..', 'Workspace', 'PromptPickerOverlay.tsx'), 'utf8'),
  fs.readFileSync(path.join(here, '..', 'Workspace', 'TabListRows.tsx'), 'utf8'),
  fs.readFileSync(path.join(here, '..', 'Workspace', 'TabSwitcherOverlay.tsx'), 'utf8'),
];

test('Settings создаёт workflow в фоне и не меняет текущий workflow', () => {
  assert.match(settings, /addWorkspaceSpace\(\{ activate: false, name: 'Workflow' \}\)/);
  assert.match(settings, /Создать workflow, не переключая текущий/);
});

test('проект имеет одного workflow-родителя, а selector формулирует перенос', () => {
  assert.match(settings, /const projectOwnerById = new Map/);
  assert.match(settings, /updateWorkspaceSpaceMetadata\(workflowId, \{ projectIds: \[\.\.\.workflow\.projectIds, projectId\] \}\)/);
  assert.match(settings, /Добавить или переместить проект/);
  assert.match(settings, /перенести из «\$\{owner\.name\}»/);
  assert.match(settings, /!isInboxProjectId\(project\.id\)/);
  assert.match(settings, /isInboxProjectId\(projectId\)/);
  assert.match(settings, /const unassignedProjects = projectRows\.filter\(\(project\) => !projectOwnerById\.has\(project\.id\)\)/);
  assert.match(settings, /Без workflow/);
});

test('workflow сохраняет порядок проектов и явно помечает первый как default', () => {
  assert.match(settings, /isDefault=\{index === 0\}/);
  assert.match(settings, /по умолчанию/);
  assert.match(settings, /Выберите проект по умолчанию/);
  assert.match(settings, /spaces\.length <= 1/);
});

test('workflow и project используют одну Settings file-input и один cropper', () => {
  assert.equal((settings.match(/type="file"/g) || []).length, 1);
  assert.equal((settings.match(/<IconCropper\b/g) || []).length, 1);
  assert.match(settings, /kind: 'workflow'/);
  assert.match(settings, /kind: 'project'/);
  assert.match(settings, /onReplaceRequest=\{\(\) => openFilePicker\(cropTarget, 'replace'\)\}/);
  assert.match(settings, /await updateProject\(target\.id, \{ icon: base64 \}\)/);
  assert.match(settings, /await updateProject\(target\.id, \{ icon: null \}\)/);
});

test('cropper минимизирует асинхронно и ждёт как async, так и sync onCrop', () => {
  assert.match(cropper, /canvas\.toBlob\(/);
  assert.match(cropper, /const minimized = await canvasToPngDataUrl\(out\)/);
  assert.match(cropper, /await Promise\.resolve\(onCrop\(minimized\)\)/);
  assert.match(cropper, /setApplyPhase\('processing'\)/);
  assert.match(cropper, /setApplyPhase\('saving'\)/);
  assert.match(cropper, /disabled=\{!ready \|\| isApplying\}/);
  assert.match(cropper, /mouseDownOnOverlay\.current = false/);
});

test('project grayscale — обратимый глобальный display toggle, metadata не переписывается', () => {
  assert.match(settings, /data-project-icons-grayscale-toggle/);
  assert.match(settings, /setProjectIconsGrayscalePreview\(!projectIconsGrayscalePreview\)/);
  assert.match(uiStore, /projectIconsGrayscalePreview: boolean/);
  assert.match(uiStore, /noted-terminal-project-icons-grayscale-preview/);
  assert.match(uiStore, /document\.documentElement\.dataset\.projectIconsGrayscale = v \? 'true' : 'false'/);
  assert.match(globals, /html\[data-project-icons-grayscale='true'\] img\[data-project-icon\]/);
  assert.match(globals, /grayscale\(1\) saturate\(0\) contrast\(1\.06\)/);
  for (const source of projectIconSurfaces) {
    assert.match(source, /data-project-icon=/,
      'одна из project-icon поверхностей обходит глобальный preview');
  }
  assert.doesNotMatch(settings, /updateProject\([^\n]+grayscale/);
});

test('project row всегда показывает серый total-tab count', () => {
  assert.match(app, /data-project-tab-count=\{projectId\}/);
  assert.match(app, /title=\{`Всего вкладок: \$\{totalTabCount\}`\}/);
  assert.match(app, /totalTabCount=\{workspace\.tabs\.size\}/);
});
