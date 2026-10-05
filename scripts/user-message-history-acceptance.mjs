import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import history from '../src/main/user-message-history.js';

// Input contains bounded Application API responses, never raw provider files.
const root = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Pass the directory of selected API response fixtures');
const expected = {
  'context-tail': { tail: 1764, prompts: [], updates: 1, carrier: 'user' },
  'named-prompts': { prompts: ['правила общения с ai', 'разбор-продуктового-решения'], updates: 0, carrier: 'user' },
  'plain-markdown': { prompts: [], updates: 0, carrier: 'user' },
  'claude-queued': { prompts: [], updates: 0, carrier: 'queued_command' },
};
const results = [];
for (const [name, checks] of Object.entries(expected)) {
  const response = JSON.parse(await fs.readFile(path.join(root, name + '.json'), 'utf8'));
  assert.equal(response.status, 200);
  const { text, kind, sessionId, turnIndex } = response.body;
  const classification = await history.classifyUserMessage({ text, turn: { kind, userUuid: 'fixture-provider-user' } });
  assert.equal(kind, checks.carrier);
  assert.equal(classification.kind, 'user');
  assert.deepEqual(classification.prompts.map(prompt => prompt.name), checks.prompts);
  assert.equal(classification.contextUpdates.length, checks.updates);
  if (checks.tail != null) assert.equal(classification.userTailChars, checks.tail);
  results.push({ name, sessionId, turnIndex, chars: text.length, textHash: createHash('sha256').update(text).digest('hex'),
    carrier: kind, classification, pass: true });
}
const report = { pass: true, proof: 'new classification on selected live API bodies; not an installed new endpoint', results };
await fs.writeFile(path.join(root, 'classification-acceptance.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ pass: true, cases: results.map(({ classification, ...row }) => ({ ...row,
  prompts: classification.prompts.map(prompt => prompt.name), userTailChars: classification.userTailChars })),
  report: path.join(root, 'classification-acceptance.json') }, null, 2));
