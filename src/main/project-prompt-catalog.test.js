const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ProjectPromptCatalogService,
  normalizeSourceRoots,
} = require('./project-prompt-catalog');

function createDb(project, sourceRoots) {
  return {
    getProjectById: (id) => id === project.id ? project : null,
    getProjectPromptSources: (id) => id === project.id
      ? sourceRoots.map((rootPath, position) => ({ projectId: id, rootPath, position }))
      : [],
    getProjectsWithPromptSources: () => [project],
    saveProjectPromptSources: (_id, roots) => roots.map((rootPath, position) => ({ rootPath, position })),
  };
}

test('catalog groups sources alphabetically and follows the shared sidebar order', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-prompts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agar = path.join(root, 'Agaratech');
  const uauth = path.join(root, 'UAuth');
  fs.mkdirSync(path.join(agar, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(uauth, 'docs'), { recursive: true });
  const first = path.join(agar, 'docs', 'first.prompt.md');
  const second = path.join(agar, 'docs', 'second.prompt.md');
  fs.writeFileSync(first, 'first');
  fs.writeFileSync(second, 'second');
  fs.writeFileSync(path.join(agar, 'docs', 'ignored.md'), 'ignored');
  fs.writeFileSync(path.join(uauth, 'docs', 'auth.prompt.md'), 'auth');

  const project = { id: 'p1', name: 'Demo', path: agar, icon: null };
  const layouts = new Map([[agar, {
    orderByParent: { [path.join(agar, 'docs')]: [second, first] },
    visualParentByPath: {},
  }]]);
  const service = new ProjectPromptCatalogService({
    db: createDb(project, [uauth, agar]),
    layoutStore: { get: sourceRoot => ({ layout: layouts.get(sourceRoot) || {} }) },
    watch: false,
  });

  const catalog = service.listProject(project.id, { force: true });
  assert.deepEqual(catalog.sources.map(source => source.sourceName), ['Agaratech', 'UAuth']);
  assert.deepEqual(catalog.prompts.map(prompt => prompt.title), ['second', 'first', 'auth']);
  assert.deepEqual(catalog.prompts.map(prompt => prompt.sourceName), ['Agaratech', 'Agaratech', 'UAuth']);
  assert.deepEqual(service.usageForRoot(agar), [{
    path: first,
    projects: [{ id: 'p1', name: 'Demo', icon: null }],
  }, {
    path: second,
    projects: [{ id: 'p1', name: 'Demo', icon: null }],
  }]);
});

test('rejects overlapping source roots for one project', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-prompts-overlap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = path.join(root, 'child');
  fs.mkdirSync(child);
  assert.throws(
    () => normalizeSourceRoots([root, child]),
    error => error.code === 'overlapping_prompt_sources',
  );
});
