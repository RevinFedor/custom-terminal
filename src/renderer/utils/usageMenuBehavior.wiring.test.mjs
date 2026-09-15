import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const component = fs.readFileSync(
  path.join(here, '..', 'components', 'Workspace', 'ClaudeUsageButton.tsx'),
  'utf8',
);

test('compact provider faces stay bound to the current local account', () => {
  assert.ok((component.match(/resolveUsageAccountPresentation\(/g) || []).length >= 2);
  assert.match(component, /compact: compactAccount/);
  assert.match(component, /compactAccountLabel/);
  assert.match(component, /compactUsageData/);
});

test('right-click refreshes the current account without opening or changing selection', () => {
  assert.ok((component.match(/onContextMenu=\{\(event\) => \{/g) || []).length >= 2);
  assert.ok((component.match(/reason: 'chip-context-menu'/g) || []).length >= 2);
  assert.ok((component.match(/accountKey: null,[\s\S]{0,80}preserveSelection: true/g) || []).length >= 2);
});

test('desktop Usage menu does not render model-specific Spark windows', () => {
  assert.doesNotMatch(component, /buildCodexAdditionalLimitRows|additionalLimitRows|codexLimitShortLabel/);
  assert.match(component, /<CodexCreditBalanceRow credits=\{usageData\.credits\}/,
    'removing Spark rows must not remove the separate Codex credit balance');
});
