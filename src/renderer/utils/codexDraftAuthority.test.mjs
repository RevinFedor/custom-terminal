import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readCodexDraftAuthority,
  resolveCodexDraftAuthority,
} from './codexDraftAuthority.mjs';
import { createRequire } from 'node:module';
const { mergeCodexDraftAuthority } = createRequire(import.meta.url)('../../main/codex-draft-authority.js');

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

test('visual positive cannot revive explicitly superseded/cancelled main observations', () => {
  const visual = {
    hasDraft: true,
    preview: 'current-looking renderer text',
    source: 'cursor:120:inline-draft',
    frameIdentity: { generation: 'current-pty', writeSeq: 120 },
  };
  for (const status of ['superseded', 'cancelled']) {
    const resolved = resolveCodexDraftAuthority({
      success: false,
      hasDraft: null,
      preview: 'old sample',
      source: 'headless-main:observation-' + status,
      observation: { status, phase: 'reading' },
    }, visual);
    assert.equal(resolved.success, false, status);
    assert.equal(resolved.hasDraft, null, status);
    assert.equal(resolved.authority, 'unknown', status);
    assert.equal(resolved.observation.status, status);
    assert.equal(resolved.visualHasDraft, true);
    assert.equal(resolved.preview, '');
  }
});

test('ordinary unknown/missing main observation still accepts conservative visual positive', () => {
  const visual = { hasDraft: true, preview: 'preserve this draft', source: 'cursor:44:inline-draft' };
  for (const main of [
    { success: false, hasDraft: null, source: 'headless-unavailable' },
    { success: false, hasDraft: null, source: 'headless-main:timeout', observation: { status: 'expired' } },
    { success: false, hasDraft: null, source: 'headless-main:read-error', observation: { status: 'failed' } },
  ]) {
    const resolved = resolveCodexDraftAuthority(main, visual);
    assert.equal(resolved.success, true);
    assert.equal(resolved.hasDraft, true);
    assert.equal(resolved.authority, 'visual-positive');
    assert.equal(resolved.preview, visual.preview);
  }
});

test('4410: pre-read visual frame125 never overrides current main empty frame148', async () => {
  const visualState = { success: true, hasDraft: true, preview: 'old multiline menu', source: 'cursor:874',
    frameIdentity: { generation: 'a7f1a64d', writeSeq: 125 } };
  const mainState = { success: true, hasDraft: false, source: 'headless-main:cursor:1020:dim-hint',
    frameIdentity: { generation: 'a7f1a64d', writeSeq: 148 } };
  const resolved = await readCodexDraftAuthority({ tabId: 'T', visualState,
    invoke: async () => mainState });
  assert.equal(resolved.hasDraft, false);
  assert.equal(resolved.authority, 'main');
  assert.equal(resolved.rendererPositiveIgnored, 'renderer-frame-behind');
  assert.equal(mergeCodexDraftAuthority(mainState, visualState, { mergeRendererPositive: true }).rendererPositiveIgnored,
    resolved.rendererPositiveIgnored, 'main and renderer use the same frame contract');
});

test('exact/newer positive frames still protect real input; unknown main never gains negative proof', () => {
  const mainState = { success: true, hasDraft: false, source: 'main',
    frameIdentity: { generation: 'G', writeSeq: 148 } };
  for (const writeSeq of [148, 149]) {
    const visualState = { success: true, hasDraft: true, preview: 'real new input',
      frameIdentity: { generation: 'G', writeSeq } };
    assert.equal(resolveCodexDraftAuthority(mainState, visualState).hasDraft, true);
    assert.equal(mergeCodexDraftAuthority(mainState, visualState, { mergeRendererPositive: true }).hasDraft, true);
  }
  for (const frameIdentity of [{ generation: 'other', writeSeq: 200 }, null]) {
    const visualState = { hasDraft: true, frameIdentity };
    assert.equal(resolveCodexDraftAuthority(mainState, visualState).hasDraft, false);
    assert.equal(resolveCodexDraftAuthority({ ...mainState, hasDraft: null }, visualState).hasDraft, true);
  }
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

test('reader forwards event-driven unknown-frame wait without polling', async () => {
  const calls = [];
  await readCodexDraftAuthority({
    invoke: async (...args) => {
      calls.push(args);
      return {
        success: true,
        hasDraft: false,
        preview: '',
        source: 'headless-main:cursor:42:dim-hint',
      };
    },
    tabId: 'tab-redraw',
    reason: 'send-during-redraw',
    timeoutMs: 700,
    waitFor: false,
    waitTimeoutMs: 2500,
    waitOnUnknownOnly: true,
    visualState: { hasDraft: null, source: 'no-terminal' },
  });

  assert.deepEqual(calls, [[
    'codex:get-draft-state',
    'tab-redraw',
    {
      reason: 'send-during-redraw',
      timeoutMs: 700,
      waitFor: false,
      waitTimeoutMs: 2500,
      waitOnUnknownOnly: true,
    },
  ]]);
});
