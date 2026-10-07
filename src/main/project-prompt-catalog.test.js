const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ProjectPromptCatalogService,
  normalizeSourceRoots,
  scanSource,
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

function tabFixture(t, { watch = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-prompts-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const a = path.join(base, 'one', 'Prompts');
  const b = path.join(base, 'two', 'Prompts');
  for (const root of [a, b]) fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(a, 'docs', 'first.prompt.md'), 'one');
  fs.writeFileSync(path.join(b, 'docs', 'second.prompt.md'), 'two');
  const source = (rootPath, rootId, enabled = true) => ({ rootPath, rootId, id: rootId, projectId: 'original-ns', position: 0, enabled });
  const bindings = new Map([
    ['opaque:a', [source(a, 'ra')]], ['opaque:b', [source(b, 'rb')]],
    ['archive-only', [source(a, 'ra')]], ['empty', []],
  ]);
  const calls = [];
  const registry = {
    sourcesForTab: id => bindings.get(id) || [],
    listSourceScopes: () => [...bindings.keys()].map(tabId => ({ id: `tab:${tabId}`, tabId, name: tabId })),
    read: () => ({ version: 1, revision: 7, roots: [a, b].map((p, i) => ({ id: i ? 'rb' : 'ra', path: p, enabled: true })) }),
    setTabSources: request => { calls.push(request); return { ...request, version: 1, revision: 8 }; },
  };
  const changes = [];
  const watches = new Map();
  const fsImpl = { ...fs, watch: (target, options, callback) => {
    const handle = { callback, options, closed: false, close() { this.closed = true; } };
    watches.set(target, handle);
    return handle;
  } };
  const db = {
    getProjectById: () => null,
    getProjectsWithPromptSources: () => { throw new Error('must not consult active Projects'); },
  };
  const service = new ProjectPromptCatalogService({ db, rootRegistry: registry, fsImpl, watch, onChanged: value => changes.push(value) });
  t.after(() => service.close());
  return { base, a, b, source, bindings, calls, registry, changes, watches, service };
}

test('tab catalogs remain exact even for tabs sharing a legacy namespace and preserve stable prompt ids', t => {
  const { a, bindings, service } = tabFixture(t);
  const first = service.listTab('opaque:a');
  assert.deepEqual(first.prompts.map(p => p.title), ['first']);
  assert.deepEqual(service.listTab('opaque:b').prompts.map(p => p.title), ['second']);
  assert.deepEqual(service.listTab('empty').prompts, []);
  assert.equal(service.listTab('opaque:a'), first, 'same exact-tab cache entry');
  assert.notEqual(service.listTab('archive-only'), first, 'no namespace cache union');
  assert.equal(first.prompts[0].id, scanSource({ projectId: 'original-ns', rootPath: a }).prompts[0].id);
  bindings.set('opaque:a', []);
  assert.deepEqual(service.listTab('opaque:a').prompts, [], 'explicit empty is observed without waiting for TTL');
  assert.deepEqual(service.usageForRoot(a)[0].tabs.map(tab => tab.id), ['archive-only']);
});

test('disabled, removed, missing sources remain readable and bound but only enabled sources scan', t => {
  const { a, b, base, source, bindings, service } = tabFixture(t);
  bindings.set('opaque:a', [
    source(a, 'ra'), source(b, 'rb', false),
    { ...source(b, 'removed', false), removed: true },
    source(path.join(base, 'missing'), 'missing'),
  ]);
  assert.equal(service.getTabSources('opaque:a').length, 4);
  assert.equal(service.getTabSources('opaque:a')[3].exists, false);
  const catalog = service.listTab('opaque:a');
  assert.deepEqual(catalog.prompts.map(p => p.title), ['first']);
  assert.equal(catalog.sources.length, 2);
  assert.equal(catalog.sources.find(s => s.rootId === 'missing').exists, false);
  assert.equal(catalog.sources[0].rootId, 'missing');
});

test('tab scans retain configured spelling, explorer order, labels and skip hidden/symlink branches', t => {
  const { a, b, base, source, bindings, service } = tabFixture(t);
  const alias = path.join(base, 'alias');
  fs.symlinkSync(a, alias);
  const first = path.join(alias, 'docs', 'first.prompt.md');
  const zed = path.join(alias, 'docs', 'zed.PROMPT.MD');
  fs.writeFileSync(zed, 'zed');
  fs.writeFileSync(path.join(a, 'docs', '.secret.prompt.md'), 'hidden');
  fs.symlinkSync(b, path.join(a, 'docs', 'escape'));
  service.layoutStore = { get: root => ({ layout: root === alias ? {
    orderByParent: { [path.join(alias, 'docs')]: [zed, first] }, visualParentByPath: {},
  } : {} }) };
  bindings.set('opaque:a', [source(alias, 'alias'), source(b, 'rb')]);
  const catalog = service.listTab('opaque:a');
  assert.deepEqual(catalog.prompts.map(p => p.title), ['zed', 'first', 'second']);
  assert.equal(catalog.prompts[1].sourceRoot, alias);
  bindings.set('opaque:a', [source(a, 'ra'), source(b, 'rb')]);
  const labels = service.listTab('opaque:a').sources.map(s => s.sourceName);
  assert.ok(labels.every(label => label.startsWith('Prompts · ')));
  assert.notEqual(labels[0], labels[1]);
});

test('source mutation validates overlap and delegates exact CAS request without altering provenance', t => {
  const { a, service, registry, calls, changes } = tabFixture(t);
  const request = { mutationId: 'm1', expectedRevision: 7, tabId: 'opaque:a', rootIds: ['rb'] };
  assert.equal(service.setTabSources(request).revision, 8);
  assert.equal(calls[0], request);
  assert.deepEqual(changes[0].tabIds, ['opaque:a']);
  assert.deepEqual(changes[0].projectIds, []);
  registry.read = () => ({ revision: 7, roots: [{ id: 'ra', path: a }, { id: 'child', path: path.join(a, 'docs') }] });
  assert.throws(() => service.setTabSources({ ...request, rootIds: ['ra', 'child'] }), error => error.code === 'overlapping_prompt_sources');
  assert.equal(calls.length, 1);
  registry.setTabSources = () => { throw Object.assign(new Error('root_revision_changed'), { code: 'root_revision_changed' }); };
  assert.throws(() => service.setTabSources({ ...request, rootIds: [] }), error => error.code === 'root_revision_changed');
  assert.equal(changes.length, 1, 'failed CAS must not publish a success');
});

test('an old committed CAS replay reaches the registry receipt despite later overlapping paths', t => {
  const { a, service, registry, calls } = tabFixture(t);
  registry.read = () => ({ version: 1, revision: 8, roots: [{ id: 'ra', path: a }, { id: 'rb', path: path.join(a, 'docs') }] });
  const request = { mutationId: 'already-committed', expectedRevision: 7, tabId: 'opaque:a', rootIds: ['ra', 'rb'] };
  assert.equal(service.setTabSources(request).revision, 8);
  assert.equal(calls[0], request);
});

test('watchers include archived-only bindings and unbound registrations and invalidate exact consumers', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { a, b, base, source, bindings, registry, watches, changes, service } = tabFixture(t, { watch: true });
  const unbound = path.join(base, 'unbound');
  fs.mkdirSync(unbound);
  registry.read = () => ({ roots: [{ id: 'unbound', path: unbound }] });
  bindings.delete('opaque:a');
  bindings.delete('opaque:b');
  service.refreshWatchers();
  assert.ok(watches.has(unbound));
  assert.equal(watches.get(path.join(b, 'docs')).closed, true);
  const before = service.listTab('archive-only');
  fs.writeFileSync(path.join(a, 'docs', 'new.prompt.md'), 'new');
  watches.get(path.join(a, 'docs')).callback();
  t.mock.timers.tick(180);
  assert.deepEqual(changes.at(-1).tabIds, ['archive-only']);
  assert.notEqual(service.listTab('archive-only'), before);
  assert.deepEqual(service.listTab('archive-only').prompts.map(p => p.title), ['first', 'new']);
  bindings.set('empty', [source(unbound, 'unbound')]);
  service.refreshWatchers();
  fs.mkdirSync(path.join(unbound, 'docs'));
  watches.get(unbound).callback();
  t.mock.timers.tick(180);
  assert.ok(watches.has(path.join(unbound, 'docs')), 'root watch follows docs creation');
  assert.equal(watches.get(unbound).closed, true);
  const missing = path.join(base, 'missing');
  bindings.set('missing-tab', [source(missing, 'missing')]);
  assert.deepEqual(service.listTab('missing-tab').prompts, []);
  fs.mkdirSync(path.join(missing, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(missing, 'docs', 'back.prompt.md'), 'back');
  assert.deepEqual(service.listTab('missing-tab').prompts.map(p => p.title), ['back']);
  assert.ok(watches.has(path.join(missing, 'docs')), 'reappearing root attaches when read without an active Project');
  service.close();
  assert.equal(watches.get(path.join(a, 'docs')).closed, true);
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
