import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as icons from 'lucide-react';
import { transformSync } from 'esbuild';
import ts from 'typescript';
import { buildPromptChipWrapper, buildHistoryComposerPresentationParts,
  restoreComposerDraftFromHistoryPresentation, removeRewindCoveredDraftContext } from '../../shared/composer-chips.mjs';
import * as origins from '../../shared/prompt-origin.mjs';
import { resolveHistoryOrchestrationPromptPresentation, resolveHistoryPromptSender } from './historyOrchestrationPromptPresentation.mjs';
const require = createRequire(import.meta.url), sha = text => createHash('sha256').update(text).digest('hex');
const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
function evaluate(source, resolve, ipcRenderer = { invoke: () => assert.fail('SSR cannot issue IPC'), on() {}, removeListener() {} }) {
  const module = { exports: {} };
  vm.runInNewContext(transformSync(source, { loader: 'tsx', format: 'cjs' }).code,
    { module, exports: module.exports, require: resolve, React,
      window: { require: () => ({ ipcRenderer }) } });
  return module.exports;
}

test('a retained Rewind wrapper roundtrips its own chip kind without recolouring ordinary context', () => {
  const wrapper = buildPromptChipWrapper({ id: 'rewind', label: 'Retained', text: 'Facts', contextUpdateId: 'ctx', contextUpdateKind: 'rewind' });
  assert.match(wrapper, /context-update-kind="rewind"/);
  const chip = buildHistoryComposerPresentationParts({ text: wrapper }).parts.find(part => part.kind === 'prompt').chip;
  assert.equal(chip.contextUpdateKind, 'rewind');
  const normal = buildPromptChipWrapper({ id: 'normal', text: 'Normal', contextUpdateId: 'old' });
  assert.doesNotMatch(normal, /context-update-kind/);
  const normalized = require('../../main/history-prompt-presentations').normalizePromptPresentationSnapshot({ promptChips: [chip] });
  assert.equal(normalized.promptChips[0].contextUpdateKind, 'rewind');
});
test('self Rewind drops returned leading context chips, not saved rules, images or literal body wrappers', () => {
  const context = buildPromptChipWrapper({ label: 'Old context', text: 'Old facts', contextUpdateId: 'old' });
  const rules = buildPromptChipWrapper({ label: 'Rules', text: 'Keep rules' });
  const text = context + '\n\n' + rules + '\n\nDeploy [Image #1]';
  const options = { text, imagePaths: [{ id: 1, path: '/finite/image.png' }], includeAuthoring: true };
  const normal = restoreComposerDraftFromHistoryPresentation(options);
  const self = restoreComposerDraftFromHistoryPresentation({ ...options, omitContextUpdates: true });
  assert.equal(normal.chips.length, 2); assert.equal(self.chips.length, 1);
  assert.equal(self.chips[0].label, 'Rules'); assert.equal(self.text, 'Deploy [Image #1]');
  assert.equal(self.imagePaths[0].path, '/finite/image.png'); assert.equal(self.authoring.chips.length, 1);
  const literal = 'Quoted later:\n' + context;
  assert.equal(restoreComposerDraftFromHistoryPresentation({ text: literal, omitContextUpdates: true }).text, literal);
});
test('current draft cleanup removes only observed exact context versions and keeps new typing byte-for-byte', () => {
  const wrapper = buildPromptChipWrapper({ label: 'Covered', text: 'Facts', contextUpdateId: 'old' });
  const current = { text: 'New user typing\n\n' + wrapper + '\nEND', chips: [
    { id: 'old-chip', kind: 'prompt', text: 'Facts', contextUpdateId: 'old' },
    { id: 'new-chip', kind: 'prompt', text: 'New facts', contextUpdateId: 'late' }] };
  const covered = [{ id: 'old', textHash: sha('Facts') }];
  const clean = removeRewindCoveredDraftContext(current, covered, sha);
  assert.equal(clean.text, 'New user typing\n\n\nEND'); assert.deepEqual(clean.chips.map(chip => chip.id), ['new-chip']);
  assert.equal(current.chips.length, 2, 'input snapshot is not mutated');
  const changed = wrapper.replace('Facts', 'Changed facts');
  assert.equal(removeRewindCoveredDraftContext({ text: changed }, covered, sha).text, changed);
  const paste = '<pasted_content>\n' + wrapper + '\n</pasted_content>';
  assert.equal(removeRewindCoveredDraftContext({ text: paste }, covered, sha).text, paste);
});
test('self provenance is typed, labelled as own Rewind, and remains an actual new task iteration', () => {
  const tag = origins.promptOriginTagForSource('codex-self-rewind:operation-1');
  assert.equal(tag.selfRewindOperationId, 'operation-1');
  assert.deepEqual(require('../../shared/prompt-origin.cjs').promptOriginTagForSource('codex-self-rewind:operation-1'), tag);
  const entry = { type: 'user', role: 'user', content: 'New model task', semanticTags: [tag] };
  const presentation = resolveHistoryOrchestrationPromptPresentation(entry);
  assert.equal(presentation.kind, 'self-rewind');
  assert.deepEqual(resolveHistoryPromptSender(presentation), { label: 'После отката', rewind: true,
    description: 'Новая задача этой же сессии после сохранённого Rewind' });
  assert.equal(origins.isServicePromptEntry(entry), false, 'a new task is not an automatic control-only turn');
  assert.equal(require('../../shared/timeline-entry-facts.cjs').isEligibleTimelineTitleEntry(entry), true);
  assert.equal(resolveHistoryOrchestrationPromptPresentation({ role: 'user', content: 'self-rewind:operation-1' }), null);
  assert.equal(require('../../main/history-prompt-presentations').normalizePromptPresentationSnapshot({ semanticTags: [tag] }).semanticTags[0].selfRewindOperationId, 'operation-1');
});
test('self header has one fresh icon and crimson chip instead of an arrow and a link to itself', () => {
  const source = evaluate(read('../components/Workspace/TabMessageSourceChip.tsx'), name => {
    if (name === 'react') return React; if (name === 'lucide-react') return icons;
    if (name.endsWith('.css') || name.endsWith('.png')) return {};
    if (name.endsWith('/useWorkspaceStore')) return { useWorkspaceStore: { getState: () => ({}) } };
    if (name.endsWith('/useUIStore')) return { useUIStore: { getState: () => ({}) } };
    return {};
  });
  const html = renderToStaticMarkup(React.createElement(source.HistoryPromptSource,
    { source: resolveHistoryPromptSender({ kind: 'self-rewind' }), phase: 'prompt' }));
  assert.match(html, /data-history-self-rewind="true"/); assert.match(html, /После отката/);
  assert.match(html, /lucide-history/); assert.match(html, /#e87994/);
  assert.doesNotMatch(html, /source-jump|data-tab-message-source=|arrow-down-left|square-terminal/);
});

const hooks = evaluate(read('../hooks/useSelfRewinds.ts'), name => name === 'react' ? React : {});
const rows = evaluate(read('../components/Workspace/RequestTrackerRow.tsx'), name => name === 'react' ? React : {});
const tracker = evaluate(read('../components/Workspace/SelfRewindTracker.tsx'), name => {
  if (name === 'react') return React; if (name === 'lucide-react') return icons;
  if (name === './RequestTrackerRow') return rows;
  if (name === './RequestDetailsPopover') return { RequestDetailsPopover: ({ children }) => React.createElement('aside', null, children) };
  if (name === './TabContextUpdates') return {};
  return {};
});
const base = { tabId: 'T', operationId: 'op', state: 'running', phase: 'rewriting', revision: 4, createdAt: 1, hasNextPrompt: false };
test('self tracker holds queued/UNKNOWN delivery, hides success, and keeps a single status icon without raw IDs', () => {
  assert.equal(tracker.selfRewindVisible(base), true);
  const completed = { ...base, state: 'completed' };
  assert.equal(tracker.selfRewindVisible(completed), false);
  for (const receiptState of ['reserved', 'audit-pending', 'delivery-unknown', 'provider-not-accepted']) {
    assert.equal(tracker.selfRewindVisible({ ...completed, hasNextPrompt: true, followup: { receiptState } }), true);
  }
  assert.equal(tracker.selfRewindVisible({ ...completed, hasNextPrompt: true, followup: { receiptState: 'confirmed' } }), false);
  const html = renderToStaticMarkup(React.createElement(tracker.SelfRewindTracker, { operation: base, onOpen() {}, onDismiss() {} }));
  assert.equal((html.match(/<svg/g) || []).length, 1); assert.match(html, /height:26px/);
  assert.doesNotMatch(html, /Операция:|op<\/|ownerToken/);
});
test('stale hydration cannot resurrect a hidden card or downgrade its confirmed followup', () => {
  const known = { ...base, state: 'completed', presentationHiddenAt: 10,
    followup: { operationKey: 'O', receiptState: 'confirmed', updatedAt: 20 } };
  const stale = { ...base, state: 'completed', revision: 5,
    followup: { operationKey: 'O', receiptState: 'audit-pending', updatedAt: 19 } };
  const result = hooks.mergeSelfRewinds([known], [stale])[0];
  assert.equal(result.presentationHiddenAt, 10); assert.equal(result.followup.receiptState, 'confirmed');
  assert.equal(tracker.selfRewindVisible(result), false);
});
test('a late dismiss result cannot enter another tab subscription after navigation', async () => {
  const slots = [], cleanups = [];
  let cursor = 0, reply;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useEffect(effect) { cleanups.push(effect()); }, useCallback: callback => callback,
  };
  const module = evaluate(read('../hooks/useSelfRewinds.ts'), name => name === 'react' ? react : {}, {
    on() {}, removeListener() {}, invoke: channel => channel === 'self-rewind:list'
      ? Promise.resolve([]) : new Promise(resolve => { reply = resolve; }),
  });
  const render = tabId => { cursor = 0; return module.useSelfRewinds(tabId); };
  const first = render('T'); await Promise.resolve();
  const pending = first.dismiss({ ...base, state: 'completed' });
  cleanups.pop()(); render('other'); await Promise.resolve();
  reply({ ...base, state: 'completed', presentationHiddenAt: 99 }); await pending;
  assert.equal(slots[0].length, 0, 'the former tab receipt must not populate the new list');
  assert.equal(slots[1], null); cleanups.pop()();
});
test('the real dock callbacks switch exact sibling selections and close only the child preview', () => {
  const source = read('../components/Workspace/OrchestrationStatusChip.tsx');
  const ast = ts.createSourceFile('dock.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const expressions = new Map();
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ['openRewind', 'openMessage', 'openRecovery', 'openInstall', 'closeMessage'].includes(node.name.getText(ast))) {
      expressions.set(node.name.getText(ast), node.initializer.getText(ast));
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const values = { message: { messageId: 'q' }, recovery: { operationKey: 'r' }, install: { jobId: 'i' }, rewind: null, historyOpen: true };
  const setter = key => value => { values[key] = typeof value === 'function' ? value(values[key]) : value; };
  const context = vm.createContext({ useCallback: fn => fn, setSettingsOpen() {}, setSelectedMessage: setter('message'),
    setSelectedRecovery: setter('recovery'), setSelectedInstall: setter('install'), setSelectedRewind: setter('rewind') });
  const callbacks = Object.fromEntries([...expressions].map(([name, expression]) => {
    const code = transformSync('globalThis.callback = ' + expression, { loader: 'tsx', format: 'cjs' }).code;
    vm.runInContext(code, context); return [name, context.callback];
  }));
  callbacks.openRewind({ operationId: 'op-1' });
  assert.equal(values.rewind.operationId, 'op-1'); assert.equal(values.message, null); assert.equal(values.recovery, null); assert.equal(values.install, null);
  callbacks.openRewind({ operationId: 'op-2' }); assert.equal(values.rewind.operationId, 'op-2');
  callbacks.openMessage({ messageId: 'q2' }); assert.equal(values.rewind, null);
  callbacks.openRewind({ operationId: 'op-2' }); callbacks.closeMessage();
  assert.equal(values.rewind, null); assert.equal(values.historyOpen, true, 'closing a child does not close request History');
});
