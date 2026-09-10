import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySavedPromptLibraryUpdate,
  createSavedPromptLibraryReceiver,
  mergeSavedPromptDraft,
  reconcileSavedPromptEditor,
  subscribeSavedPromptLibraryChanges,
  subscribeSavedPromptUpdates,
} from './savedPromptUpdateEvents.mjs';

test('an open picker accepts creates, deletes and group changes before an older load finishes', () => {
  let shown;
  const receiver = createSavedPromptLibraryReceiver(library => { shown = library; });
  const old = { groups: [{ id: 1, name: 'old group' }], prompts: [{ id: 'a' }, { id: 'b' }] };
  receiver.receiveLoad(old, receiver.generation());
  const pendingLoadGeneration = receiver.generation();
  const changed = {
    groups: [{ id: 2, name: 'new group' }],
    prompts: [{ id: 'c', group_id: 2 }, { id: 'b', group_id: 2 }],
  };
  assert.equal(receiver.receiveChange({ library: changed }), true);
  assert.deepEqual(shown.prompts.map(prompt => prompt.id), ['c', 'b']);
  assert.deepEqual(shown.groups, [{ id: 2, name: 'new group' }]);
  assert.equal(receiver.receiveLoad(old, pendingLoadGeneration), false);
  assert.equal(shown, changed);
  assert.equal(receiver.receiveChange({ library: { prompts: [] } }), false);
  assert.equal(shown, changed);
});

test('saved prompt update subscription refreshes only valid prompt events and unregisters cleanly', () => {
  const listeners = new Map();
  const ipcRenderer = {
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel, listener) { if (listeners.get(channel) === listener) listeners.delete(channel); },
  };
  const received = [];
  const unsubscribe = subscribeSavedPromptUpdates(ipcRenderer, (prompt) => received.push(prompt));
  listeners.get('prompts:updated')({}, { id: 'prompt-11286', title: 'fresh' });
  listeners.get('prompts:updated')({}, { title: 'invalid' });
  assert.deepEqual(received, [{ id: 'prompt-11286', title: 'fresh' }]);
  unsubscribe();
  assert.equal(listeners.has('prompts:updated'), false);
});

test('saved prompt event keeps dirty Settings fields while refreshing clean fields', () => {
  const saved = {
    id: 'prompt-11286', title: 'old title', content: 'saved content', file_paths: ['/old.md'],
  };
  const titleOnlyUpdate = {
    ...saved, title: 'new title', revision: 'title-only',
  };
  assert.deepEqual(
    mergeSavedPromptDraft(saved, {
      title: 'old title', content: 'user draft', file_paths: ['/old.md'],
    }, titleOnlyUpdate),
    { title: 'new title', content: 'user draft', file_paths: ['/old.md'] },
  );
  const fullUpdate = {
    ...titleOnlyUpdate, content: 'remote content', file_paths: ['/new.md'], revision: 'full-update',
  };
  assert.deepEqual(
    mergeSavedPromptDraft(saved, {
      title: 'old title', content: 'saved content', file_paths: ['/old.md'],
    }, fullUpdate),
    { title: 'new title', content: 'remote content', file_paths: ['/new.md'] },
  );
});

test('saved prompt library update preserves unrelated rows and stable-id selection', () => {
  const selected = { id: 'prompt-11286', title: 'old', content: 'old content' };
  const unrelated = { id: 'prompt-other', title: 'other', content: 'keep' };
  const rows = [selected, unrelated];
  const updated = applySavedPromptLibraryUpdate(rows, { id: 'prompt-11286', title: 'new', content: 'new content' });
  assert.notEqual(updated, rows);
  assert.equal(updated[1], unrelated);
  assert.equal(updated.find((row) => row.id === 'prompt-11286').title, 'new');
  assert.equal(applySavedPromptLibraryUpdate(rows, { id: 'missing', title: 'ignored' }), rows);
});

test('open picker adopts a matching prompt event and releases its listener on close', () => {
  const listeners = new Map();
  const ipcRenderer = {
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel, listener) { if (listeners.get(channel) === listener) listeners.delete(channel); },
  };
  let rows = [
    { id: 'prompt-11286', title: 'old title', content: 'body' },
    { id: 'prompt-other', title: 'other', content: 'keep' },
  ];
  const selectedId = 'prompt-11286';
  const unsubscribe = subscribeSavedPromptUpdates(ipcRenderer, (prompt) => {
    rows = applySavedPromptLibraryUpdate(rows, prompt);
  });
  listeners.get('prompts:updated')({}, { id: 'prompt-11286', title: 'new title', content: 'body' });
  assert.equal(rows.find((row) => row.id === selectedId).title, 'new title');
  assert.equal(rows.find((row) => row.id === 'prompt-other').content, 'keep');
  unsubscribe();
  assert.equal(listeners.has('prompts:updated'), false);
});

test('catalog refresh keeps a dirty editor attached to B after A is removed or B moves', () => {
  const a = { id: 'a', title: 'A', content: 'a', file_paths: [] };
  const b = { id: 'b', title: 'B', content: 'saved b', file_paths: [] };
  const c = { id: 'c', title: 'C', content: 'c', file_paths: [] };
  const draft = { title: 'B', content: 'dirty b', file_paths: [] };
  const afterDeleteA = reconcileSavedPromptEditor({
    prompts: [a, b, c], nextPrompts: [b, c], editingPromptId: 'b', draft,
  });
  assert.equal(afterDeleteA.editingPromptId, 'b');
  assert.equal(afterDeleteA.editingIndex, 0);
  assert.equal(afterDeleteA.draft.content, 'dirty b');
  assert.equal(afterDeleteA.prompts.find((prompt) => prompt.id === 'c').content, 'c');
  const movedB = { ...b, position: 0 };
  const afterMoveB = reconcileSavedPromptEditor({
    prompts: [a, b, c], nextPrompts: [movedB, a, c], editingPromptId: 'b', draft,
  });
  assert.equal(afterMoveB.editingPromptId, 'b');
  assert.equal(afterMoveB.editingIndex, 0);
  assert.equal(afterMoveB.draft.content, 'dirty b');
  assert.equal(afterMoveB.prompts.find((prompt) => prompt.id === 'c').content, 'c');
});

test('catalog refresh closes an editor whose prompt was deleted and never targets C with its draft', () => {
  const b = { id: 'b', title: 'B', content: 'saved b', file_paths: [] };
  const c = { id: 'c', title: 'C', content: 'c', file_paths: [] };
  const result = reconcileSavedPromptEditor({
    prompts: [b, c], nextPrompts: [c], editingPromptId: 'b',
    draft: { title: 'B', content: 'dirty b', file_paths: [] },
  });
  assert.equal(result.editingPromptId, null);
  assert.equal(result.editingIndex, null);
  assert.equal(result.prompts[0].id, 'c');
  assert.equal(result.prompts[0].content, 'c');
});

test('prompt-library change subscription unregisters on close', () => {
  const listeners = new Map();
  const ipcRenderer = {
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel, listener) { if (listeners.get(channel) === listener) listeners.delete(channel); },
  };
  const unsubscribe = subscribeSavedPromptLibraryChanges(ipcRenderer, () => {});
  assert.ok(listeners.has('prompt-library:changed'));
  unsubscribe();
  assert.equal(listeners.has('prompt-library:changed'), false);
});
