const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSavedPromptService } = require('./saved-prompt-service');
const { buildPromptOutline } = require('../shared/prompt-outline.cjs');

let ownedRoot;
const electronPath = require.resolve('electron'), previousElectron = require.cache[electronPath];
require.cache[electronPath] = { id: electronPath, loaded: true,
  exports: { app: { isPackaged: false, getPath: () => ownedRoot } } };
const DatabaseManager = require('./database');
if (previousElectron) require.cache[electronPath] = previousElectron; else delete require.cache[electronPath];
const incident = require('./fixtures/prompt-library-mixed-order.json');
const p = (id, position, extra = {}) => ({ id, title: id, content: 'owned body ' + id, position,
  group_id: null, visual_parent_id: null, file_paths: ['/owned/' + id + '.md'], ...extra });
const sample = () => ({ groups: [
  { id: 1, name: 'A', position: 0, description: 'keep A', is_collapsed: false },
  { id: 2, name: 'B', position: 20, description: 'keep B', is_collapsed: true },
], prompts: [p('a', 10), p('a-child', 11, { visual_parent_id: 'a' }), p('b', 30),
  p('inside', 100, { group_id: 1 }), p('inside-child', 101, { group_id: 1, visual_parent_id: 'inside' })] });

function fixture(t, initial = sample()) {
  ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-prompt-order-'));
  const directory = ownedRoot, db = new DatabaseManager();
  db.savePromptGroups(initial.groups); db.savePrompts(initial.prompts);
  const changes = [];
  const service = createSavedPromptService({ projectManager: db, onChanged: value => changes.push(value) });
  const library = () => db.getPromptLibrary();
  const roots = () => buildPromptOutline(library().prompts, library().groups).map(node => node.id);
  const rowIds = () => db.db.prepare('SELECT id, stable_id, created_at FROM prompts ORDER BY id').all();
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { db, service, changes, library, roots, rowIds };
}

function definitions(state) {
  return state.prompts.map(({ position, ...rest }) => rest).sort((a, b) => a.id.localeCompare(b.id));
}

for (const append of ['original-34', 'in-range']) test('exact incident preserves mixed roots on append ' + append, t => {
  const initial = { groups: incident.groups.map(([id, position]) => ({ id, position, name: 'Group ' + id })),
    prompts: incident.prompts.map(([id, group_id, visual_parent_id, position, fileCount]) => p(id, position, {
      group_id, visual_parent_id,
      file_paths: Array.from({ length: fileCount }, (_, index) => '/owned/' + id + '-' + index + '.md'),
    })) };
  const h = fixture(t, initial), before = h.library(), order = h.roots(), ids = h.rowIds();
  h.service.createPrompt({ stableId: 'own-incident', title: 'Owned new prompt', text: 'owned new body',
    position: append === 'original-34' ? 34 : order.length });
  assert.deepEqual(h.roots(), [...order, 'prompt:own-incident']);
  assert.deepEqual(definitions(h.library()).filter(row => row.id !== 'own-incident'), definitions(before));
  assert.deepEqual(h.library().groups.map(({ position, ...rest }) => rest), before.groups.map(({ position, ...rest }) => rest));
  assert.deepEqual(h.rowIds().filter(row => row.stable_id !== 'own-incident'), ids);
});

test('middle prompt/group insertion and position updates share root siblings, preserving nested definitions', t => {
  const h = fixture(t), before = h.library();
  h.service.createPrompt({ stableId: 'new', title: 'New', text: 'new', position: 2 });
  assert.deepEqual(h.roots(), ['prompt-group:1', 'prompt:a', 'prompt:new', 'prompt-group:2', 'prompt:b']);
  const group = h.service.createGroup({ name: 'New group', position: 3 });
  assert.ok(h.changes.at(-1).groupIds.includes(group.id));
  assert.ok(h.changes.at(-1).groupIds.every(id => typeof id === 'number'));
  assert.deepEqual(h.roots(), ['prompt-group:1', 'prompt:a', 'prompt:new', 'prompt-group:' + group.id, 'prompt-group:2', 'prompt:b']);
  h.service.updateGroup({ groupId: 2, revision: h.service.getGroup(2).revision, position: 1 });
  assert.deepEqual(h.roots(), ['prompt-group:1', 'prompt-group:2', 'prompt:a', 'prompt:new', 'prompt-group:' + group.id, 'prompt:b']);
  h.service.update({ stableId: 'b', revision: h.service.get('b').revision, position: 2 });
  assert.deepEqual(h.roots(), ['prompt-group:1', 'prompt-group:2', 'prompt:b', 'prompt:a', 'prompt:new', 'prompt-group:' + group.id]);
  assert.deepEqual(definitions(h.library()).filter(row => before.prompts.some(old => old.id === row.id)), definitions(before));
  assert.equal(h.service.get('inside-child').position, before.prompts.find(row => row.id === 'inside-child').position);
});

test('moving an existing subtree at root and between groups keeps unrelated root order', t => {
  const h = fixture(t);
  h.service.movePrompt({ stableId: 'b', revision: h.service.get('b').revision, position: 1 });
  assert.deepEqual(h.roots(), ['prompt-group:1', 'prompt:b', 'prompt:a', 'prompt-group:2']);
  h.service.movePrompt({ stableId: 'inside', revision: h.service.get('inside').revision, groupId: null, position: 2 });
  assert.deepEqual(h.roots(), ['prompt-group:1', 'prompt:b', 'prompt:inside', 'prompt:a', 'prompt-group:2']);
  assert.equal(h.service.get('inside-child').group_id, null);
  assert.equal(h.service.get('inside-child').visual_parent_id, 'inside');
  h.service.movePrompt({ stableId: 'a', revision: h.service.get('a').revision, groupId: 2, position: 0 });
  assert.deepEqual(h.roots(), ['prompt-group:1', 'prompt:b', 'prompt:inside', 'prompt-group:2']);
  assert.equal(h.service.get('a-child').group_id, 2); assert.equal(h.service.get('a-child').visual_parent_id, 'a');
});

test('child insertion normalizes only its siblings and never moves a root or a separate group member', t => {
  const h = fixture(t), roots = h.roots(), before = h.library();
  h.service.createPrompt({ stableId: 'second-child', title: 'Second child', text: 'x', parentPromptId: 'a', position: 0 });
  assert.deepEqual(h.roots(), roots);
  assert.deepEqual(buildPromptOutline(h.library().prompts, h.library().groups)[1].children.map(node => node.promptId), ['second-child', 'a-child']);
  for (const group of before.groups) assert.equal(h.service.getGroup(group.id).position, group.position);
  assert.equal(h.service.get('inside').position, 100);
  assert.equal(h.service.get('b').position, 30);
});

test('text-only update leaves every position and neighbouring SQL row unchanged; second-connection edit survives', t => {
  const h = fixture(t), before = h.library(), old = h.service.get('a');
  const second = new DatabaseManager();
  try {
    const otherClient = createSavedPromptService({ projectManager: second });
    otherClient.update({ stableId: 'b', revision: otherClient.get('b').revision, text: 'concurrent body' });
  } finally { second.close(); }
  h.service.update({ stableId: 'a', revision: old.revision, text: 'new own text' });
  assert.deepEqual(h.library().groups, before.groups);
  assert.deepEqual(h.library().prompts.map(row => [row.id, row.position]), before.prompts.map(row => [row.id, row.position]));
  assert.equal(h.service.get('b').content, 'concurrent body');
  const saved = h.library();
  assert.throws(() => h.service.update({ stableId: 'a', revision: old.revision, position: 0 }), error => error.code === 'saved_prompt_stale');
  assert.deepEqual(h.library(), saved);
});

test('order changes invalidate affected group revisions and stale operations are atomic', t => {
  const h = fixture(t), group = h.service.getGroup(2), prompt = h.service.get('a');
  h.service.createPrompt({ stableId: 'first', title: 'First', position: 0 });
  const after = h.library();
  assert.throws(() => h.service.updateGroup({ groupId: 2, revision: group.revision, position: 0 }), error => error.code === 'prompt_group_stale');
  assert.throws(() => h.service.movePrompt({ stableId: 'a', revision: prompt.revision, position: 0 }), error => error.code === 'saved_prompt_stale');
  assert.deepEqual(h.library(), after);
});

test('stable ties use the canonical outline, not a new lexical prompt sorter', t => {
  const h = fixture(t, { groups: [{ id: 1, name: 'G', position: 0 }], prompts: [p('z', 0), p('a', 0)] });
  const before = h.roots();
  h.service.createPrompt({ stableId: 'last', title: 'Last', position: before.length });
  assert.deepEqual(h.roots(), [...before, 'prompt:last']);
});

test('Settings facade uses the same canonical builder/writer as the repaired service', async () => {
  const facade = await import('../renderer/components/UI/promptOutlineModel.mjs');
  const shared = require('../shared/prompt-outline.cjs');
  assert.equal(facade.buildPromptOutline, shared.buildPromptOutline);
  assert.equal(facade.applyPromptOutline, shared.applyPromptOutline);
});
