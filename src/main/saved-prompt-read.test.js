'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSavedPromptService } = require('./saved-prompt-service');
const { buildPromptOutline, promptOutlineSelection } = require('../shared/prompt-outline.cjs');
const prompt = (id, extra = {}) => ({ id, title: id, content: id + ' body', file_paths: [], ...extra });
const group = (id, extra = {}) => ({ id, name: 'group ' + id, ...extra });
const part = async row => [row.content];
function fixture(state) {
  let reads = 0;
  const service = createSavedPromptService({ projectManager: { getPromptLibrary() { reads++; return state; } } });
  return { service, reads: () => reads };
}
const steps = (service, id, extra = {}) => service.readResolvedSteps({
  promptIds: [id], mode: 'resolved', projection: 'steps-v1', resolvePart: part, ...extra,
});
const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children)]);

test('outline preserves canonical mixed/stable ties, absent positions, empty/collapsed groups without bodies', () => {
  const state = { groups: [group('opaque:G'), group(4, { position: 1, is_collapsed: true }), group(7, { position: 9 })],
    prompts: [prompt('zero'), prompt('tie', { position: 1 }), prompt('inside', { group_id: 4, position: 7 }),
      prompt('child', { group_id: 4, visual_parent_id: 'inside', position: 0 })] };
  const f = fixture(state), plain = f.service.catalog();
  const result = f.service.catalog({ projection: 'outline-v1', requestId: 'native-read-A' });
  assert.deepEqual(result.groups, plain.groups); assert.deepEqual(result.prompts, plain.prompts);
  assert.deepEqual(result.outline.roots.map(x => x.id), buildPromptOutline(state.prompts, state.groups).map(x => x.id));
  assert.deepEqual(result.outline.roots.map(x => x.id), ['prompt-group:opaque:G', 'prompt:zero', 'prompt-group:4', 'prompt:tie', 'prompt-group:7']);
  assert.equal(result.outline.roots[2].expanded, false);
  assert.equal(result.outline.roots[0].hasChildren, false);
  assert.equal(result.outline.roots[2].children[0].children[0].inheritanceDepth, 1);
  assert.equal(result.read.requestId, 'native-read-A'); assert.match(result.read.libraryRevision, /^[a-f0-9]{64}$/);
  for (const row of flatten(result.outline.roots)) {
    assert.equal('rawPrompt' in row, false); assert.equal('content' in row, false);
  }
});

test('one leaf resolves separate root-to-leaf payloads, exact source keys and immediate parents', async () => {
  const state = { groups: [], prompts: [prompt('root'), prompt('middle', { visual_parent_id: 'root' }),
    prompt('葉:leaf', { visual_parent_id: 'middle' }), prompt('sibling', { visual_parent_id: 'middle' })] };
  const f = fixture(state), result = await steps(f.service, '葉:leaf');
  assert.equal(f.reads(), 1);
  assert.deepEqual(result.composition.steps.map(x => [x.promptId, x.sourceKey, x.inheritanceDepth, x.inheritanceParentPromptId]),
    [['root', 'prompt:root', 0, null], ['middle', 'prompt:middle', 1, 'root'], ['葉:leaf', 'prompt:葉:leaf', 2, 'middle']]);
  assert.equal(result.prompts[0].content, '葉:leaf body');
  assert.equal(result.prompts[0].resolvedText, 'root body\n\nmiddle body\n\n葉:leaf body');
  const sibling = await steps(f.service, 'sibling');
  assert.deepEqual(sibling.composition.steps.slice(0, 2), result.composition.steps.slice(0, 2), 'same source keys allow client merge without duplicating ancestors');
});

test('legacy invalid/missing/cross-group/cyclic parents and orphan groups match actual canonical outline', async () => {
  const state = { groups: [group(1)], prompts: [
    prompt('valid', { group_id: 1 }), prompt('cross', { visual_parent_id: 'valid' }),
    prompt('absent', { visual_parent_id: 'gone' }), prompt('self', { visual_parent_id: 'self' }),
    prompt('cycle-a', { visual_parent_id: 'cycle-b' }), prompt('cycle-b', { visual_parent_id: 'cycle-a' }),
    prompt('cycle-child', { visual_parent_id: 'cycle-a' }),
    prompt('orphan-root', { group_id: 444 }), prompt('orphan-child', { group_id: 555, visual_parent_id: 'orphan-root' }),
  ] };
  const f = fixture(state), outline = buildPromptOutline(state.prompts, state.groups);
  const catalog = f.service.catalog({ projection: 'outline-v1' });
  for (const row of state.prompts) {
    const result = await steps(f.service, row.id);
    assert.deepEqual(result.composition.steps.map(x => x.promptId), promptOutlineSelection(outline, row.id).map(x => x.promptId));
    const own = catalog.prompts.find(x => x.id === row.id), shown = flatten(catalog.outline.roots).find(x => x.promptId === row.id);
    assert.equal(shown.revision, own.revision); assert.equal(result.read.selectedRevision, own.revision);
  }
  assert.deepEqual((await steps(f.service, 'orphan-child')).composition.steps.map(x => x.promptId), ['orphan-root', 'orphan-child']);
  assert.equal(state.prompts.at(-1).group_id, 555, 'read never persists normalized relations');
});

test('read traverses existing deep legacy tree without introducing a new depth cap', async () => {
  const state = { groups: [], prompts: Array.from({ length: 40 }, (_, n) => prompt('D' + n, { visual_parent_id: n ? 'D' + (n - 1) : null })) };
  const result = await steps(fixture(state).service, 'D39');
  assert.equal(result.composition.steps.length, 40); assert.equal(result.composition.steps.at(-1).inheritanceDepth, 39);
});

test('empty resolved ancestor rejects whole composition with failing identity and read evidence', async () => {
  const state = { groups: [], prompts: [prompt('empty', { content: ' ', title: 'Empty parent' }), prompt('leaf', { visual_parent_id: 'empty' })] };
  const f = fixture(state); let leavesRead = 0;
  await assert.rejects(steps(f.service, 'leaf', { resolvePart: async row => { if (row.id === 'leaf') leavesRead++; return [row.content]; } }),
    e => e.statusCode === 409 && e.code === 'saved_prompt_empty' && e.promptId === 'empty' && e.promptTitle === 'Empty parent'
      && e.read.selectedPromptId === 'leaf');
  assert.equal(leavesRead, 0);
  assert.equal((await f.service.readMany({ promptIds: ['empty'], mode: 'own' }))[0].content, ' ');
});

test('library snapshot is captured once before awaited file reads, even with in-place concurrent edits', async () => {
  const state = { groups: [group(1)], prompts: [prompt('root', { group_id: 1 }), prompt('leaf', { group_id: 1, visual_parent_id: 'root' })] };
  const f = fixture(state), catalog = f.service.catalog({ projection: 'outline-v1' });
  let release, entered; const held = new Promise(r => { release = r; }), ready = new Promise(r => { entered = r; });
  const pending = steps(f.service, 'leaf', { expectedLibraryRevision: catalog.read.libraryRevision, resolvePart: async row => {
    if (row.id === 'root') { entered(); await held; } return [row.content];
  } });
  await ready; state.prompts[0].content = 'new root'; state.prompts[1].content = 'new leaf'; state.prompts[1].visual_parent_id = null;
  state.groups[0].name = 'changed'; release();
  const result = await pending;
  assert.equal(f.reads(), 2); assert.equal(result.read.libraryRevision, catalog.read.libraryRevision);
  assert.equal(result.prompts[0].resolvedText, 'root body\n\nleaf body');
  assert.notEqual(f.service.catalog({ projection: 'outline-v1' }).read.libraryRevision, result.read.libraryRevision);
  let readParts = 0;
  await assert.rejects(steps(f.service, 'leaf', { expectedLibraryRevision: catalog.read.libraryRevision, resolvePart: async () => { readParts++; return 'x'; } }),
    e => e.code === 'saved_prompt_library_stale' && e.statusCode === 409);
  assert.equal(readParts, 0, 'stale catalog is rejected before linked files');
});

test('old own/resolved batch shape is preserved and resolver receives one captured graph', async () => {
  const state = { groups: [], prompts: [prompt('A'), prompt('B')] }, f = fixture(state);
  const result = await f.service.readMany({ promptIds: ['A', 'B'], mode: 'resolved', resolveText: async (row, graph) => {
    state.prompts[1].content = 'changed'; return row.content + '/' + graph[1].content;
  } });
  assert.equal(f.reads(), 1); assert.deepEqual(result.map(x => x.resolvedText), ['A body/B body', 'B body/B body']);
  assert.equal('composition' in result[0], false);
});

test('unsupported projection, missing leaf, malformed scope and multiple leaves remain distinct errors', async () => {
  const f = fixture({ groups: [], prompts: [prompt('leaf')] });
  assert.throws(() => f.service.catalog({ projection: 'future' }), e => e.code === 'saved_prompt_projection_invalid');
  assert.throws(() => f.service.catalog({ projection: 'outline-v1', requestId: [] }), e => e.code === 'saved_prompt_read_id_invalid');
  await assert.rejects(steps(f.service, 'gone'), e => e.code === 'saved_prompt_not_found' && e.statusCode === 404);
  await assert.rejects(steps(f.service, 'leaf', { promptIds: ['leaf', 'leaf'] }), e => e.code === 'saved_prompt_selection_invalid');
  await assert.rejects(steps(f.service, 'leaf', { mode: 'own' }), e => e.code === 'saved_prompt_projection_invalid');
  await assert.rejects(steps(f.service, 'leaf', { expectedLibraryRevision: 'wrong' }), e => e.code === 'saved_prompt_library_revision_invalid');
});
