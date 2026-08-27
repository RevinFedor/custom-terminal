import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const history = fs.readFileSync(
  new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url),
  'utf8',
);

test('sent prompt ancestry grows from the right edge and never widens History', () => {
  assert.match(history, /className="hp-history-user-prompt-chip-slot"/);
  const band = history.slice(
    history.indexOf('.hp-history-user-prompt-band {'),
    history.indexOf('.hp-agent-prompt::-webkit-scrollbar-thumb:hover'),
  );
  assert.match(band, /flex-direction: row-reverse;/);
  assert.match(band, /justify-content: flex-start;/);
  assert.match(band, /width: 100%;/);
  assert.match(band, /min-width: 0;/);
  assert.match(band, /max-width: 100%;/);
  assert.match(band, /overflow-x: clip;/);
  assert.match(band, /\.hp-history-user-prompt-chip-slot \{[\s\S]*max-width: 100%;/);
  assert.match(band, /\.hp-history-user-prompt-chip-slot \.cb-composer-chip \{[\s\S]*max-width: min\(240px, 100%\);/);
  assert.match(band, /\.hp-history-user-prompt-chip-slot \.cb-composer-chip-label \{[\s\S]*text-overflow: ellipsis;[\s\S]*white-space: nowrap;/);
});
