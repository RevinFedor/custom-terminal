import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadPickerPromptCatalog, promptCatalogChangeAffectsTarget, promptRootChoices, promptSourceSearchPath, promptRootForSelectedFolder, togglePromptRoot, tabPromptBindingRequest, validatePromptRootSnapshot } from './promptTabSourcesModel.mjs';

test('source settings show the configured root and fixed docs search folder without rewriting a root named docs',()=>{
  assert.equal(promptSourceSearchPath('/source/'),'/source/docs');
  assert.equal(promptSourceSearchPath('/'),'/docs');
  assert.equal(promptSourceSearchPath({rootPath:'/alias/source'}),'/alias/source/docs');
  assert.equal(promptSourceSearchPath({rootPath:'/old',path:'/new'}),'/new/docs');
  assert.equal(promptSourceSearchPath('/source/docs'),'/source/docs/docs');
  assert.equal(promptSourceSearchPath(''),'');
});

test('choosing the known docs search folder reuses its registration; an exact registered docs root has priority',()=>{
  const parent={id:'parent',path:'/source'},docs={id:'docs-root',path:'/source/docs'};
  assert.equal(promptRootForSelectedFolder({roots:[parent]},'/source/docs/'),parent);
  assert.equal(promptRootForSelectedFolder({roots:[parent,docs]},'/source/docs'),docs);
  assert.equal(promptRootForSelectedFolder({roots:[parent]},'/unknown/docs'),undefined);
  assert.equal(promptRootForSelectedFolder({roots:[{id:'slash',path:'/'}]},'/').id,'slash');
});

test('migrated picker reads the captured opaque target, never its common execution namespace', async () => {
  const requests = [];
  const ipc = { invoke: async (...args) => {
    requests.push(args);
    return { success: true, data: { tabId: args[1], prompts: [{ id: 'stable:legacy' }], sources: [] } };
  } };
  const target = { tabId: 'captured:tab', projectId: '__global_namespace__', organizationReady: true };
  const catalog = await loadPickerPromptCatalog(ipc, target);
  assert.deepEqual(requests, [['project-prompts:list-tab', 'captured:tab']]);
  assert.equal(catalog.project.name, 'Промпты рабочего пространства');
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

test('picker keeps captured insertion targets while source controls live in workflow settings', () => {
  const picker = fs.readFileSync(new URL('./PromptPickerOverlay.tsx', import.meta.url), 'utf8');
  assert.match(picker, /const pickerTabId = contextRequest\?\.tabId \|\| shortcutTarget\?\.tabId/);
  assert.match(picker, /const target = \{tabId:pickerTabId,projectId:pickerProjectId,organizationReady\}/);
  assert.match(picker, /read:\(\) => loadPickerPromptCatalog\(ipcRenderer,target\)/);
  const settings = fs.readFileSync(new URL('../UI/WorkflowDirectorySettings.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(picker, /data-prompt-tab-sources-action/);
  assert.doesNotMatch(settings, /workflow:tab-roots|project-prompts:set-tab-sources|<select/);
  assert.match(settings, /app:select-directory/);
  assert.match(settings, /promptDirectories/);
  assert.match(picker, /handleSelectPrompt\(p, event\.metaKey\)/);
  assert.match(picker, /handleCopyPrompt\(event, p\)/);
  assert.match(picker, /subscribeSavedPromptLibraryChanges/);
  assert.doesNotMatch(picker, /window\.prompt\(/);
});
