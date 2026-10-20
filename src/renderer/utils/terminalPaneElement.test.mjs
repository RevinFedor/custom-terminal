import test from 'node:test';
import assert from 'node:assert/strict';
import { findTerminalPaneElement } from './terminalPaneElement.mjs';

const node = (id, isConnected = true) => ({ isConnected,
  getAttribute: key => key === 'data-terminal-pane-wrapper' ? id : null });

test('the indexed retained owner avoids scanning the full workspace', () => {
  const current = node('tab-a'); let lookups = 0;
  const doc = { getElementById(id) { lookups++; assert.equal(id, 'terminal-pane-wrapper:tab-a'); return current; },
    querySelector() { throw Error('full workspace scan'); } };
  assert.equal(findTerminalPaneElement('tab-a', doc), current);
  assert.equal(lookups, 1);
});

test('replacement is read fresh instead of reusing an old connected wrapper', () => {
  const first = node('tab-a'), second = node('tab-a'); let current = first;
  const doc = { getElementById: () => current, querySelector() { throw Error('unexpected scan'); } };
  assert.equal(findTerminalPaneElement('tab-a', doc), first); current = second;
  assert.equal(findTerminalPaneElement('tab-a', doc), second);
});

test('missing, detached or foreign indexed elements preserve the legacy exact lookup', () => {
  for (const indexed of [null, node('foreign'), node('tab:a"b', false)]) {
    const fallback = node('tab:a"b'); let scans = 0, escaped = 0;
    const doc = { getElementById: () => indexed,
      defaultView: { CSS: { escape(id) { escaped++; assert.equal(id, 'tab:a"b'); return 'escaped-id'; } } },
      querySelector(selector) { scans++; assert.equal(selector, '[data-terminal-pane-wrapper="escaped-id"]'); return fallback; } };
    assert.equal(findTerminalPaneElement('tab:a"b', doc), fallback);
    assert.equal(scans, 1); assert.equal(escaped, 1);
  }
});

test('absent legacy owner remains absent without selecting a neighboring tab', () => {
  const doc = { getElementById: () => null, defaultView: { CSS: { escape: value => value } },
    querySelector: () => null };
  assert.equal(findTerminalPaneElement('empty', doc), null);
});


test('vacant pane chrome has no tab wrapper and never scans the retained workspace', () => {
  let idReads = 0, scans = 0;
  const doc = { getElementById() { idReads++; return null; },
    defaultView: { CSS: { escape: value => value } },
    querySelector() { scans++; return null; } };
  // Actual four-workflow diagnostic observed twelve searches for this sentinel.
  for (let i = 0; i < 12; i++) assert.equal(findTerminalPaneElement('', doc), null);
  assert.equal(idReads, 0); assert.equal(scans, 0);
});
