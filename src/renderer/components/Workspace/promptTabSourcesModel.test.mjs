import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { isCurrentPickerGeneration } from '../../utils/promptInsertMenuModel.mjs';
import { loadPickerPromptCatalog, promptCatalogChangeAffectsTarget, promptRootChoices, togglePromptRoot, tabPromptBindingRequest, validatePromptRootSnapshot } from './promptTabSourcesModel.mjs';

test('migrated picker reads the captured opaque target, never its common execution namespace', async () => {
  const requests = [];
  const ipc = { invoke: async (...args) => {
    requests.push(args);
    return { success: true, data: { tabId: args[1], prompts: [{ id: 'stable:legacy' }], sources: [] } };
  } };
  const target = { tabId: 'captured:tab', projectId: '__global_namespace__', organizationReady: true };
  const catalog = await loadPickerPromptCatalog(ipc, target);
  assert.deepEqual(requests, [['project-prompts:list-tab', 'captured:tab']]);
  assert.equal(catalog.project.name, 'Промпты вкладки');
  assert.equal(catalog.prompts[0].id, 'stable:legacy');
  await loadPickerPromptCatalog(ipc, { ...target, organizationReady: false });
  assert.deepEqual(requests.at(-1), ['project-prompts:list', '__global_namespace__']);
  assert.equal(await loadPickerPromptCatalog(ipc, { ...target, tabId: null }), null);
});

test('registry errors stay errors rather than silently reading namespace-wide prompts', async () => {
  const requests = [];
  const ipc = { invoke: async (...args) => { requests.push(args); return { success: false, error: 'root_forward_version' }; } };
  await assert.rejects(loadPickerPromptCatalog(ipc, { tabId: 'target', projectId: 'legacy', organizationReady: true }), /root_forward_version/);
  assert.equal(requests.length, 1);
});

test('filesystem updates are filtered by exact tab while legacy project-only payloads still refresh', () => {
  const target = { tabId: 'T', projectId: 'N', organizationReady: true };
  assert.equal(promptCatalogChangeAffectsTarget({ tabIds: ['other'], projectIds: ['N'] }, target), false);
  assert.equal(promptCatalogChangeAffectsTarget({ tabIds: ['T'] }, target), true);
  assert.equal(promptCatalogChangeAffectsTarget({ tabIds: [] }, target), false);
  assert.equal(promptCatalogChangeAffectsTarget({ projectIds: ['N'] }, target), true);
  assert.equal(promptCatalogChangeAffectsTarget({ projectIds: ['other'] }, { ...target, organizationReady: false }), false);
});

test('editor retains disabled/missing/removed bindings and sends ordered explicit-empty CAS choices', () => {
  const snapshot = {
    version: 1, revision: 19, rootIds: ['removed', 'missing'],
    roots: [{ id: 'missing', path: '/missing', name: 'Missing', enabled: false }, { id: 'new', path: '/new', enabled: true }],
    sources: [{ rootId: 'removed', rootPath: '/old', removed: true, enabled: false }, { rootId: 'missing', rootPath: '/missing', exists: false }],
  };
  const choices = promptRootChoices(snapshot);
  assert.deepEqual(choices.map(r => r.id), ['removed', 'missing', 'new']);
  assert.equal(choices[0].path, '/old');
  assert.equal(choices[1].exists, false);
  assert.equal(choices[1].enabled, false);
  const ids = togglePromptRoot(snapshot.rootIds, 'new', true);
  assert.deepEqual(ids, ['removed', 'missing', 'new']);
  assert.deepEqual(snapshot.rootIds, ['removed', 'missing']);
  assert.equal(togglePromptRoot(ids, 'new', true), ids);
  assert.deepEqual(tabPromptBindingRequest(snapshot, 'opaque', [], 'uuid'), {
    tabId: 'opaque', rootIds: [], mutationId: 'uuid', expectedRevision: 19,
  });
  assert.throws(() => tabPromptBindingRequest({ version: 2, revision: 1 }, 'opaque', [], 'uuid'), /version/);
});

test('picker wiring uses captured targets and inline source controls while retaining existing insertion callbacks', () => {
  const picker = fs.readFileSync(new URL('./PromptPickerOverlay.tsx', import.meta.url), 'utf8');
  assert.match(picker, /const pickerTabId = contextRequest\?\.tabId \|\| shortcutTarget\?\.tabId/);
  assert.match(picker, /loadPickerPromptCatalog\(ipcRenderer, \{ tabId: pickerTabId/);
  assert.match(picker, /ipcRenderer\.invoke\('workflow:tab-roots', pickerTabId\)/);
  assert.match(picker, /ipcRenderer\.invoke\('project-prompts:set-tab-sources', request\)/);
  assert.match(picker, /ipcRenderer\.invoke\('app:select-directory'\)/);
  assert.match(picker, /ipcRenderer\.invoke\('workflow:save-root'/);
  assert.match(picker, /data-prompt-tab-sources-editor/);
  assert.match(picker, /handleSelectPrompt\(p, event\.metaKey\)/);
  assert.match(picker, /handleCopyPrompt\(event, p\)/);
  assert.match(picker, /subscribeSavedPromptLibraryChanges/);
  assert.doesNotMatch(picker, /window\.prompt\(/);
});

function actualSourceActions(invoke, extra = {}) {
  const picker = fs.readFileSync(new URL('./PromptPickerOverlay.tsx', import.meta.url), 'utf8');
  const start = picker.indexOf('  const openSourceEditor = useCallback');
  const marker = '  }, [pickerTabId, sourceSnapshot]);';
  const end = picker.indexOf(marker, start) + marker.length;
  assert.ok(start > 0 && end > start);
  const state = { open: false, busy: false, error: '', rootIds: ['old'], snapshot: null, revision: 0 };
  const generation = { current: 1 };
  const operation = { current: false };
  const sourceSnapshot = { version: 1, revision: 8, roots: [], rootIds: ['old'], sources: [] };
  const set = key => value => { state[key] = typeof value === 'function' ? value(state[key]) : value; };
  const context = {
    useCallback: callback => callback,
    pickerTabId: 'captured-target', sourceSnapshot, sourceRootIds: ['old'],
    activePickerGenerationRef: generation, sourceOperationRef: operation,
    ipcRenderer: { invoke }, crypto: { randomUUID: () => 'generated-uuid' },
    setSourcesOpen: set('open'), setSourceBusy: set('busy'), setSourceError: set('error'),
    setSourceSnapshot: set('snapshot'), setSourceRootIds: set('rootIds'), setCatalogRevision: set('revision'),
    isCurrentPickerGeneration, tabPromptBindingRequest, togglePromptRoot, validatePromptRootSnapshot,
    ...extra,
  };
  const script = transformSync(picker.slice(start, end) + '\nglobalThis.actions = { openSourceEditor, saveTabSources, addPromptFolder };', { loader: 'ts' }).code;
  vm.runInNewContext(script, context);
  return { actions: context.actions, state, generation, operation };
}

test('actual editor handlers snapshot the captured tab and ignore late results after a different picker opens', async () => {
  let finish;
  const requests = [];
  const f = actualSourceActions((...args) => { requests.push(args); return new Promise(resolve => { finish = resolve; }); });
  const pending = f.actions.openSourceEditor();
  assert.deepEqual(requests, [['workflow:tab-roots', 'captured-target']]);
  assert.equal(f.state.busy, true);
  f.generation.current = 2;
  finish({ version: 1, revision: 9, rootIds: ['foreign'] });
  await pending;
  assert.equal(f.state.snapshot, null);
  assert.deepEqual(f.state.rootIds, ['old']);
  assert.equal(f.operation.current, false);
});

test('actual Save sends exact CAS and failed CAS retains the choices without reporting success', async () => {
  const requests = [];
  const f = actualSourceActions(async (...args) => { requests.push(args); return { success: false, error: 'root_revision_changed' }; });
  f.state.open = true;
  await f.actions.saveTabSources();
  assert.equal(requests[0][0], 'project-prompts:set-tab-sources');
  assert.equal(requests[0][1].tabId, 'captured-target');
  assert.equal(requests[0][1].expectedRevision, 8);
  assert.equal(requests[0][1].mutationId, 'generated-uuid');
  assert.deepEqual(Array.from(requests[0][1].rootIds), ['old']);
  assert.match(f.state.error, /root_revision_changed/);
  assert.equal(f.state.open, true);
  assert.equal(f.state.revision, 0);
});

test('actual Add registers a folder with CAS then requires the acknowledged revision before keeping the draft', async () => {
  const requests = [];
  const f = actualSourceActions(async (...args) => {
    requests.push(args);
    if (args[0] === 'app:select-directory') return '/chosen';
    if (args[0] === 'workflow:save-root') return { id: 'new', version: 1, revision: 9 };
    return { version: 1, revision: 10, roots: [{ id: 'new', path: '/chosen' }], rootIds: ['concurrent-choice'] };
  });
  await f.actions.addPromptFolder();
  assert.equal(requests[1][1].expectedRevision, 8);
  assert.equal(requests[1][1].path, '/chosen');
  assert.equal(requests[1][1].enabled, true);
  assert.deepEqual(requests[2], ['workflow:tab-roots', 'captured-target']);
  assert.equal(f.state.snapshot, null, 'must not silently adopt newer binding revision');
  assert.deepEqual(f.state.rootIds, ['old']);
  assert.match(f.state.error, /изменился/);
});

test('actual Add reuses an existing registration and never changes cwd or creates a Project', async () => {
  const requests = [];
  const f = actualSourceActions(async (...args) => { requests.push(args); return '/registered'; }, {
    sourceSnapshot: { version: 1, revision: 8, roots: [{ id: 'existing', path: '/registered' }] },
  });
  await f.actions.addPromptFolder();
  assert.deepEqual(requests, [['app:select-directory']]);
  assert.deepEqual(Array.from(f.state.rootIds), ['old', 'existing']);
});
