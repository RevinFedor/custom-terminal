import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPromptCatalog, buildPromptResult, selectPrompt } from './terminal-prompt-catalog.mjs';

const payload = {
  etag: 'etag-1',
  groups: [{ id: 4, name: 'база', position: 0 }],
  prompts: [
    {
      id: 'prompt-full',
      title: 'FULL документация',
      content: 'Короткая инструкция',
      resolvedText: 'Короткая инструкция\n\nБольшой файл правил',
      group_id: 4,
      position: 1,
      file_paths: ['/tmp/docs-rules.prompt.md'],
    },
    {
      id: 'prompt-mini',
      title: 'MINI документация',
      content: 'Ссылка на правила',
      resolvedText: 'Ссылка на правила',
      group_id: null,
      position: 2,
      file_paths: [],
      revision: 'prompt-mini-revision',
    },
  ],
};

test('catalog is compact and can filter by title or group', () => {
  const catalog = buildPromptCatalog(payload, 'база');
  assert.equal(catalog.count, 1);
  assert.deepEqual(catalog.prompts[0], {
    id: 'prompt-full',
    title: 'FULL документация',
    groupId: 4,
    groupName: 'база',
    parentPromptId: null,
    position: 1,
    fileCount: 1,
    ownTextLength: 19,
    resolvedTextLength: 40,
  });
  assert.equal('text' in catalog.prompts[0], false);
});

test('compact catalog metadata keeps file and text lengths without prompt bodies', () => {
  const compact = {
    groups: [{ id: 4, name: 'база', position: 0 }],
    prompts: [{
      id: 'prompt-compact', title: 'Compact', group_id: 4, visual_parent_id: null, position: 1,
      fileCount: 3, ownTextLength: 751, revision: 'catalog-revision',
    }],
  };
  const row = buildPromptCatalog(compact).prompts[0];
  assert.equal(row.fileCount, 3);
  assert.equal(row.ownTextLength, 751);
  assert.equal(row.resolvedTextLength, null);
  assert.equal('content' in row, false);
});

test('one prompt can be selected by id or exact title', () => {
  assert.equal(selectPrompt(payload, { promptId: 'prompt-mini' }).title, 'MINI документация');
  assert.equal(selectPrompt(payload, { title: 'full ДОКУМЕНТАЦИЯ' }).id, 'prompt-full');
  assert.throws(() => selectPrompt(payload, { title: 'missing' }), /not found/i);
  assert.throws(() => selectPrompt(payload, { promptId: 'prompt-mini', title: 'FULL документация' }), /different prompts/i);
  assert.throws(
    () => selectPrompt({ ...payload, prompts: [...payload.prompts, { ...payload.prompts[0], id: 'prompt-full-copy' }] }, { title: 'FULL документация' }),
    /repeat with promptId/i,
  );
});

test('own mode excludes attached file text and resolved mode matches inserted text', () => {
  const prompt = selectPrompt(payload, { promptId: 'prompt-full' });
  assert.equal(buildPromptResult(payload, prompt, 'own').text, 'Короткая инструкция');
  assert.equal(buildPromptResult(payload, prompt, 'resolved').text, 'Короткая инструкция\n\nБольшой файл правил');
  assert.deepEqual(buildPromptResult(payload, prompt, 'own').filePaths, ['/tmp/docs-rules.prompt.md']);
  assert.match(buildPromptResult(payload, prompt, 'resolved').resolutionNote, /cannot be read/i);
});

test('prompt result preserves the revision required for an optimistic update', () => {
  const prompt = selectPrompt(payload, { promptId: 'prompt-mini' });
  assert.equal(buildPromptResult(payload, prompt, 'own').revision, 'prompt-mini-revision');
});
