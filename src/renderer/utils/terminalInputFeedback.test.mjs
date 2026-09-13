import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { installTerminalInputFeedback } from './terminalInputFeedback.mjs';

test('a written Escape flashes only its History/terminal frames; arrows and unwritten requests do not', async () => {
  const ipc = new EventEmitter(), seen = [], cancelled = [];
  const element = id => ({ isConnected: true, getClientRects: () => [1],
    animate: (frames, options) => {
      seen.push({ id, frames, options });
      return { finished: Promise.resolve(), cancel: () => cancelled.push(id) };
    },
  });
  const history = element('history-A'), terminal = element('terminal-A'), other = element('history-B');
  const document = { querySelectorAll: () => [
    { getAttribute: () => 'A', querySelector: () => history },
    { getAttribute: () => 'B', querySelector: () => other },
  ] };
  const stop = installTerminalInputFeedback({ ipc, document, getTerminal: tab => tab === 'A' ? { element: terminal } : null });
  ipc.emit('terminal:input-feedback', null, { tabId: 'A', key: 'ArrowUp', written: true });
  ipc.emit('terminal:input-feedback', null, { tabId: 'A', key: 'Escape', written: false });
  assert.equal(seen.length, 0);
  ipc.emit('terminal:input-feedback', null, { tabId: 'A', key: 'Escape', written: true });
  assert.deepEqual(seen.map(item => item.id), ['history-A', 'terminal-A']);
  assert.equal(seen[0].options.duration, 450);
  assert.ok(seen[0].frames[1].outline.includes('1)'));
  ipc.emit('terminal:input-feedback', null, { tabId: 'A', key: 'Escape', written: true });
  assert.equal(cancelled.length, 2, 'another key restarts, rather than stacking, the flash');
  stop();
  assert.equal(ipc.listenerCount('terminal:input-feedback'), 0);
});

test('main publishes feedback after the actual physical and API Escape writes', () => {
  const source = readFileSync(new URL('../../main/main.js', import.meta.url), 'utf8');
  for (const provider of ['claude', 'codex']) {
    assert.match(source, new RegExp("snapshot\\.terminal\\.write\\('\\\\x1b'\\);\\s*notifyTerminalEscapeWritten\\(tabId, '" + provider + "-interrupt-turn'\\)"));
  }
  assert.match(source, /term\.write\(data\);\s*if \(isPureEscapeBurst && !isTerminalProtocolResponse\) notifyTerminalEscapeWritten/);
});
