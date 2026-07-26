import assert from 'node:assert/strict';
import test from 'node:test';

import { requireCommittedCodexRewind } from './codexRewindCommit.ts';

test('accepts a committed adopted child without depending on the proof label', () => {
  assert.deepEqual(
    requireCommittedCodexRewind({
      success: true,
      bindingCommitted: true,
      handoffStatus: 'adopted-child',
      sourceSessionId: 'source',
      activeSessionId: 'child',
    }, 'source'),
    {
      sourceSessionId: 'source',
      activeSessionId: 'child',
      writerChanged: true,
    },
  );
});

test('accepts a committed stable source and marks its history projection pending', () => {
  assert.deepEqual(
    requireCommittedCodexRewind({
      success: true,
      bindingCommitted: true,
      handoffStatus: 'stable-source',
      sourceSessionId: 'source',
      activeSessionId: 'source',
    }, 'source'),
    {
      sourceSessionId: 'source',
      activeSessionId: 'source',
      writerChanged: false,
    },
  );
});

test('does not duplicate the main-process handoff taxonomy', () => {
  assert.equal(
    requireCommittedCodexRewind({
      success: true,
      bindingCommitted: true,
      handoffStatus: 'future-main-owned-proof-mode',
      sourceSessionId: 'source',
      activeSessionId: 'child',
    }, 'child').writerChanged,
    true,
  );
});

test('rejects an uncommitted or incomplete result', () => {
  assert.throws(
    () => requireCommittedCodexRewind({
      success: true,
      bindingCommitted: false,
      sourceSessionId: 'source',
      activeSessionId: 'source',
    }, 'source'),
    /сохранённый результат сессии не подтверждён/,
  );
  assert.throws(
    () => requireCommittedCodexRewind({
      success: true,
      bindingCommitted: true,
      sourceSessionId: 'source',
      activeSessionId: '',
    }, 'source'),
    /сохранённый результат сессии не подтверждён/,
  );
});

test('rejects a reply after the tab has moved to an unrelated writer', () => {
  assert.throws(
    () => requireCommittedCodexRewind({
      success: true,
      bindingCommitted: true,
      sourceSessionId: 'source',
      activeSessionId: 'child',
    }, 'newer-writer'),
    /вкладка уже перешла на другую ветку/,
  );
});
