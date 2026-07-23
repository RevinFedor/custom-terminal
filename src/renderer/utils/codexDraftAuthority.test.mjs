import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readCodexDraftAuthority,
  resolveCodexDraftAuthority,
} from './codexDraftAuthority.mjs';

test('headless empty proof remains authoritative when floating terminal is hidden', () => {
  assert.deepEqual(
    resolveCodexDraftAuthority(
      {
        success: true,
        hasDraft: false,
        preview: '',
        source: 'headless-main:cursor:21:dim-hint',
      },
      {
        hasDraft: null,
        preview: '',
        source: 'no-terminal',
      },
    ),
    {
      success: true,
      hasDraft: false,
      preview: '',
      source: 'headless-main:cursor:21:dim-hint',
      authority: 'main',
      visualHasDraft: null,
      visualSource: 'no-terminal',
      visualPreview: '',
      visualDebug: '',
    },
  );
});

test('visual empty state cannot replace an unknown main/headless result', () => {
  const resolved = resolveCodexDraftAuthority(
    {
      success: true,
      hasDraft: null,
      preview: '',
      source: 'headless-main:unknown',
    },
    {
      hasDraft: false,
      preview: '',
      source: 'cursor:9:dim-hint',
    },
  );
  assert.equal(resolved.hasDraft, null);
  assert.equal(resolved.authority, 'unknown');
});

test('visual positive state preserves a draft even when headless reports empty', () => {
  const resolved = resolveCodexDraftAuthority(
    {
      success: true,
      hasDraft: false,
      preview: '',
      source: 'headless-main:cursor:21:dim-hint',
    },
    {
      hasDraft: true,
      preview: 'unsent user text',
      source: 'cursor:9:inline-draft',
    },
  );
  assert.equal(resolved.hasDraft, true);
  assert.equal(resolved.preview, 'unsent user text');
  assert.equal(resolved.authority, 'main-plus-visual-positive');
});

test('reader asks main even when renderer terminal is absent', async () => {
  const calls = [];
  const resolved = await readCodexDraftAuthority({
    invoke: async (...args) => {
      calls.push(args);
      return {
        success: true,
        hasDraft: false,
        preview: '',
        source: 'headless-main:cursor:42:dim-hint',
      };
    },
    tabId: 'tab-hidden',
    reason: 'hidden-terminal-picker',
    timeoutMs: 900,
    visualState: {
      hasDraft: null,
      preview: '',
      source: 'no-terminal',
    },
  });

  assert.deepEqual(calls, [[
    'codex:get-draft-state',
    'tab-hidden',
    { reason: 'hidden-terminal-picker', timeoutMs: 900 },
  ]]);
  assert.equal(resolved.hasDraft, false);
  assert.equal(resolved.authority, 'main');
});
