import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const history = fs.readFileSync(
  new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url),
  'utf8',
);

test('sent prompt and context-update chips keep LTR order at the bubble right edge', () => {
  assert.match(history, /className="hp-history-user-prompt-chip-slot"/);
  const band = history.slice(
    history.indexOf('.hp-history-user-prompt-band {'),
    history.indexOf('.hp-agent-prompt::-webkit-scrollbar-thumb:hover'),
  );
  assert.match(band, /flex-direction: row;/);
  assert.match(band, /flex-wrap: nowrap;/);
  assert.match(band, /justify-content: flex-end;/);
  assert.doesNotMatch(band, /row-reverse|direction:\s*rtl/);
  assert.match(band, /width: 100%;/);
  assert.match(band, /align-self: stretch;/);
  assert.match(band, /min-width: 0;/);
  assert.match(band, /max-width: 100%;/);
  assert.match(band, /overflow-x: hidden;/);
  assert.match(band, /\.hp-history-user-prompt-chip-slot \{[^}]*max-width: min\(240px, 100%\);/);
  assert.match(band, /\.hp-history-user-prompt-chip-slot \.cb-composer-chip \{[\s\S]*max-width: min\(240px, 100%\);/);
  assert.match(band, /\.hp-history-user-prompt-chip-slot \.cb-composer-chip-label \{[\s\S]*text-overflow: ellipsis;[\s\S]*white-space: nowrap;/);
});
