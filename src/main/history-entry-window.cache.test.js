'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const grammar = require('../shared/history-action-grammar.cjs');
const { makeHistoryRowStub, applyHistoryRowWindow } = require('./history-entry-window');

const row = rawTool => ({ uuid: 'u1', sessionId: 'sid', role: 'assistant', actions: [{ tool: '__raw__', rawTool }] });
const freshStub = entry => makeHistoryRowStub(structuredClone(entry));

test('retained tool metadata is reused exactly without reparsing the same command', () => {
  let parses = 0;
  const requireObserved = name => name.endsWith('history-action-grammar.cjs')
    ? { ...grammar, historyActionPresentationMeta: (...args) => { parses++; return grammar.historyActionPresentationMeta(...args); } }
    : require(name);
  // Create args in the same realm, like JSON.parse does in the application.
  const context = { require: requireObserved, module: { exports: {} }, __dirname };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'history-entry-window.js'), 'utf8') + `
    const fixture = { uuid:'u',role:'assistant',actions:[{tool:'__raw__',rawTool:{toolName:'Bash',args:{command:'node -e "fixture"'},result:'done'}}] };
    for (let i=0;i<30;i++) applyHistoryRowWindow([fixture,{uuid:'tail'}],{radius:1,alwaysHydrateTail:1});
    fixture.actions[0].rawTool.args.command='git status';
    applyHistoryRowWindow([fixture,{uuid:'tail'}],{radius:1,alwaysHydrateTail:1});
  `, context);
  assert.equal(parses, 2, 'one first compute and one exact changed command, not 31 parses');
});

test('argument replacement/mutation, absent keys and presentation classifier changes match uncached output', () => {
  const entry = row({ toolName: 'Bash', family: 'bash', bashWord: 'node', args: { command: 'node scripts/a.js' }, result: 'done' });
  const mutations = [
    raw => { raw.args.command = 'node scripts/b.js'; },
    raw => { raw.args = { command: 'rg -n needle docs/guide.md', path: 'docs/guide.md' }; raw.family = 'search'; raw.bashWord = 'rg'; },
    raw => { delete raw.family; delete raw.bashWord; raw.args.command = 'git status --short'; },
    raw => { raw.bashDetail = 'diff'; },
    raw => { raw.toolName = 'Read'; raw.args = { file_path: '/repo/docs/A.md', offset: 3, limit: 5 }; },
    raw => { raw.args.offset = 0; delete raw.args.limit; },
    raw => { raw.toolName = 'mcp__knowledge__docs_search'; raw.mcpServer = 'knowledge'; raw.mcpMethod = 'docs_search'; },
    raw => { raw.mcpServer = 'terminal'; raw.mcpMethod = 'current_context'; },
    raw => { raw.isError = true; raw.toolUseId = 'late-id'; },
  ];
  for (const mutate of mutations) {
    makeHistoryRowStub(entry); mutate(entry.actions[0].rawTool);
    assert.deepEqual(makeHistoryRowStub(entry), freshStub(entry));
  }
});

test('structured or accessor arguments never receive an unsafe shallow cache hit', () => {
  let value = 'docs/a.md';
  const args = { get file_path() { return value; }, edits: [{ text: 'x' }] };
  const entry = row({ toolName: 'Read', args });
  makeHistoryRowStub(entry); value = 'src/b.ts'; args.edits[0].text = 'changed';
  assert.deepEqual(makeHistoryRowStub(entry), makeHistoryRowStub(row({ toolName: 'Read', args: { file_path: value, edits: args.edits } })));
});

test('late live-work/result flags and moving hydration windows retain original behavior', () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({ ...row({ toolUseId: 'c'+i,
    toolName: 'Bash', args: { command: 'node script'+i+'.js' }, result: 'done' }), uuid: 'u'+i }));
  for (const centerUuid of [null, 'u2', 'u8', 'missing', null]) {
    const hydrate = { centerUuid, radius: 2, alwaysHydrateTail: 1 };
    assert.deepEqual(applyHistoryRowWindow(entries, hydrate), applyHistoryRowWindow(structuredClone(entries), hydrate));
  }
  entries[0].actions[0].rawTool.backgroundStatus = 'running';
  assert.equal(applyHistoryRowWindow(entries, { radius: 2, alwaysHydrateTail: 1 }).entries[0].rowStub, undefined);
  entries[0].actions[0].rawTool.backgroundStatus = 'completed';
  assert.equal(applyHistoryRowWindow(entries, { radius: 2, alwaysHydrateTail: 1 }).entries[0].rowStub, true);
  const output = makeHistoryRowStub(entries[0]); output.actionSummary[0].targetLabel = 'caller mutation';
  assert.deepEqual(makeHistoryRowStub(entries[0]), freshStub(entries[0]), 'cached labels do not escape as a mutable shared object');
});
