import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(
  path.join(here, '../components/Workspace/HistoryPanel.tsx'),
  'utf8',
);

test('History draft reads use the same three-valued preflight as scenario sends', () => {
  const start = source.indexOf('const readTerminalDraft = useCallback');
  const end = source.indexOf('\n  useEffect(() => {', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  assert.match(body, /classifyAgentDraftPreflight\(draftState\)/);
  assert.doesNotMatch(
    body,
    /if \(draftState\.hasDraft === false\)/,
    'a raw boolean may contradict an explicit unknown proof outcome',
  );
});
