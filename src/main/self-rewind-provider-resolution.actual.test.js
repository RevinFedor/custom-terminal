'use strict';
// `rewind_self` defaulted the provider to Codex on a Claude tab.
//
// E2E 02.11, isolated stand, tab 215d81406552 running Claude Haiku: the session
// was told to rewind itself and called the tool WITHOUT `toolType`, which the
// schema allows. `historyOperationArgs` filled in the historical default
// 'codex', and the app refused at its input fence:
//
//   HTTP 409 history_input_owner_changed
//   [HistoryInput] RESERVE_REFUSED tab=215d81406552 terminalToken=present
//     toolType="claude"/"codex" sessionId=<same>/<same>
//     projectId="__tab_catalog_v2__" cwd=<stand cwd> stopping=false
//
// Nine fields share that one refusal code, so the message named none of them;
// only the instrumented run showed the provider pair. This was reachable only
// after the content-revision requirement was lifted: before that a Claude self
// rewind failed earlier, at `history_revision_required`.
//
// The fix: a SELF rewind has no business guessing. The provider is a property
// of the calling tab, so the caller resolves it from that tab and refuses when
// it cannot. `rewind_history`, which addresses ANOTHER conversation, keeps its
// historical codex default — there the caller really is choosing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'mcp', 'terminal-server.mjs'), 'utf8');
const section = (from, to) => {
  const start = source.indexOf(from);
  assert.ok(start > 0, 'anchor not found: ' + from);
  const end = source.indexOf(to, start);
  assert.ok(end > start, 'section end not found: ' + to);
  return source.slice(start, end);
};

test('a self rewind does not default the provider to codex', () => {
  const args = section('function historyOperationArgs', 'async function ensureSavedHistorySupport');
  assert.match(args, /selfRewind \? null : 'codex'/,
    'the codex fallback must be withheld from a self rewind');
  assert.doesNotMatch(args, /const toolType = args\.toolType === undefined \? 'codex' : args\.toolType;/,
    'the unconditional codex default is what sent a Claude tab in as Codex');
});

test('rewind_history keeps the codex default for another conversation', () => {
  const args = section('function historyOperationArgs', 'async function ensureSavedHistorySupport');
  // Same expression, read for the OTHER branch: without selfRewind it is still
  // 'codex'. Changing that would break every existing Codex rewind caller.
  assert.match(args, /args\.toolType === undefined \? \(selfRewind \? null : 'codex'\)/);
});

test('an unresolved provider is not forwarded as a request field', () => {
  const args = section('function historyOperationArgs', 'async function ensureSavedHistorySupport');
  assert.match(args, /\.\.\.\(toolType \? \{ toolType \} : \{\}\)/,
    'a null provider must be omitted, never sent as toolType: null');
});

test('the self rewind case resolves its own tab provider before mutating', () => {
  const self = section("case 'rewind_self':", "case 'rewind_history':");
  assert.match(self, /if \(!request\.toolType\)/, 'it must fill in an unresolved provider');
  assert.match(self, /commandType/, 'from the tab listing, which carries commandType');
  assert.match(self, /self_rewind_provider_unresolved/, 'and refuse when it cannot be resolved');
  // Ordering is the whole point: the resolution has to happen before anything
  // that can change history. mutationAttempted marks that boundary.
  const resolve = self.indexOf('self_rewind_provider_unresolved');
  const attempt = self.indexOf('mutationAttempted = true');
  assert.ok(resolve > 0 && attempt > resolve,
    'the provider must be resolved before the mutation is attempted');
});

test('the resolved provider is what the capability check and request carry', () => {
  const self = section("case 'rewind_self':", "case 'rewind_history':");
  const assign = self.indexOf('request.toolType = resolved');
  const capability = self.indexOf('ensureSavedHistorySupport(target, request.toolType');
  assert.ok(assign > 0 && capability > assign,
    'capability support must be checked for the resolved provider, not a guess');
});

test('only claude or codex is accepted from the tab listing', () => {
  const self = section("case 'rewind_self':", "case 'rewind_history':");
  assert.match(self, /\['claude', 'codex'\]\.includes\(resolved\)/,
    'a gemini/file/empty commandType must not become a saved-history provider');
});

test('an explicit toolType is still honoured', () => {
  const self = section("case 'rewind_self':", "case 'rewind_history':");
  // The resolution is a fallback, not an override: a caller that knows its
  // provider (or a test fixture) must keep passing it.
  assert.match(self, /if \(!request\.toolType\) \{/);
  assert.match(self, /'toolType'/, 'toolType stays an accepted self-rewind argument');
});
