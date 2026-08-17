import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const appSource = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const webSource = fs.readFileSync(new URL('../../main/web-server.js', import.meta.url), 'utf8');

test('Project API routes focused context through the renderer resolver', () => {
  assert.match(webSource, /\/api\/focused-terminal-context/);
  assert.match(webSource, /bridgeRequest\('getFocusedTerminalContext'/);
  assert.match(appSource, /action === 'getFocusedTerminalContext'/);
  assert.match(appSource, /resolveFocusedTerminalSelection\(liveState\)/);
  assert.match(appSource, /historySessionId/);
  assert.match(appSource, /getTabChromeColorConfig\(tab\)/);
});
