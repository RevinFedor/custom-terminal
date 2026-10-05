import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSystemPromptDraft } from './systemPromptDraft.mjs';

test('external metadata changes refresh clean fields and preserve an unsaved system instruction', () => {
  const base = { id: 'tab-title', revision: 'old', content: 'before', name: 'Title', color: '#123456', filePaths: [] };
  const draft = { ...base, content: 'my unsaved text' };
  const incoming = { ...base, revision: 'new', name: 'Заголовок', color: '#abcdef', filePaths: ['/tmp/rules.md'] };
  const merged = mergeSystemPromptDraft(base, draft, incoming);
  assert.equal(merged.draft.content, 'my unsaved text');
  assert.equal(merged.draft.name, 'Заголовок');
  assert.deepEqual(merged.draft.filePaths, ['/tmp/rules.md']);
  assert.deepEqual(merged.conflicts, []);
  assert.equal(merged.baseline.revision, 'new');
});

test('a same-field conflict survives later metadata refreshes until explicitly resolved', () => {
  const base = { id: 'tab-title', revision: 'old', content: 'before', color: '#123456' };
  const draft = { ...base, content: 'local text' };
  const incoming = { ...base, revision: 'new', content: 'remote text' };
  let merged = mergeSystemPromptDraft(base, draft, incoming);
  assert.deepEqual(merged.conflicts, ['content']);
  assert.equal(merged.baseline.revision, 'old');
  merged = mergeSystemPromptDraft(merged.baseline, merged.draft, { ...incoming, revision: 'newer', color: '#abcdef' });
  assert.equal(merged.draft.content, 'local text');
  assert.equal(merged.draft.color, '#abcdef');
  assert.equal(merged.baseline.revision, 'old');
  const resolved = mergeSystemPromptDraft(merged.baseline, { ...merged.draft, content: 'remote text' }, incoming);
  assert.deepEqual(resolved.conflicts, []);
  assert.equal(resolved.baseline.revision, 'new');
});
