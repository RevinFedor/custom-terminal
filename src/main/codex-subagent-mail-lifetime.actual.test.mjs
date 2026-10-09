import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCodexSubagentTracker } = require('./codex-subagent-cards');
const { createCodexChildCompletionWatch } = require('./codex-child-completion-watch');
const { readAgentCompletionProof } = require('./subagent-transcript');
const { OrchestrationRunStore } = require('./orchestration-runs');
const codexDataModule = require('./ipc/codex-data');
const main = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const tree = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
const functions = new Map(tree.statements.filter(ts.isFunctionDeclaration)
  .map(node => [node.name?.text, node.getText(tree)]));
const source = ['getCombinedTabBackgroundWorkCount', 'getTabBackgroundWorkAgents',
  'getTabTerminalCodexSubagents', 'parseCodexLiveArgs', 'publishCodexSubagentActivity', 'trackCodexTabSubagentActivity']
  .map(name => { assert.ok(functions.has(name), name); return functions.get(name); }).join('\n');

// Exact incident identities, synthetic records only. No production journal,
// process, provider, input, renderer, or installed application is touched.
const TAB = 'fixture-3607';
const CHILD = '01a11ee3-352f-7e62-9915-ffc0aed6c2a6';
const SPAWN = 'call_adab99097eef414abf6482cfa1d37712';
const MAIL = 'call_96aade36b5f3410c8b23188160a4168a';
const NAME = '/root/ui_modifier_reveal_e2e';
const GENERATION = 'fixture:1';
const START = Date.parse('2026-10-09T06:11:00.198Z');
const END = Date.parse('2026-10-09T06:16:06.605Z');
const MAIL_TIME = '2026-10-09T06:18:17.668Z';
const record = (type, payload, timestamp = MAIL_TIME) => ({ type, payload, timestamp });
const control = (name = 'send_message', id = MAIL, extra = {}) => record('response_item', {
  type: 'function_call', name, namespace: 'collaboration', call_id: id,
  arguments: JSON.stringify({ target: NAME, message: 'Mailbox acknowledgement; not a new task.' }), ...extra,
});
const output = (id = MAIL, value = '') => record('response_item', {
  type: 'function_call_output', call_id: id, output: value,
});
const interacted = (id = MAIL) => record('event_msg', {
  type: 'sub_agent_activity', kind: 'interacted', event_id: id,
  agent_path: NAME, agent_thread_id: CHILD,
});

function liveHarness({ active = false } = {}) {
  const launchSettings = { version: 1, provider: 'codex', sessionId: CHILD,
    source: 'subagent-started', model: 'gpt-6-luna', effort: 'max' };
  const agent = { taskName: NAME, threadId: CHILD, sessionId: 'fixture-parent',
    generation: GENERATION, startedAt: START, launchSettings,
    ...(!active ? { completedAt: END, terminalStatus: 'completed' } : {}) };
  const live = new Map(active ? [[TAB, new Map([[SPAWN, agent]])]] : []);
  const known = new Map([[TAB, new Map([[SPAWN, agent]])]]);
  const publications = [], logs = [], callbacks = new Map();
  let completion = { finished: false, completedAt: 0 };
  const watcher = createCodexChildCompletionWatch({
    findFile: () => 'synthetic-child', sessionsDir: () => 'synthetic-sessions',
    readCompletion: ({ notBefore }) => completion.completedAt >= notBefore ? completion
      : { finished: false, completedAt: 0 },
    watchFile: (file, _options, callback) => {
      callbacks.set(file, callback);
      return { on() {}, close() { callbacks.delete(file); } };
    },
    isCurrent: (tabId, key, current, startedAt, generation) => live.get(tabId)?.get(key) === current
      && current.startedAt === startedAt && current.generation === generation && generation === GENERATION,
    onComplete: (tabId, key, current, proof) => {
      live.get(tabId).delete(key);
      current.completedAt = proof.completedAt; current.terminalStatus = 'completed';
      context.publishCodexSubagentActivity(tabId);
    },
  });
  const context = vm.createContext({ Date, Map, Number, String, Object, JSON, require, path,
    srcMainDir: path.dirname(new URL('./main.js', import.meta.url).pathname),
    codexTabLiveSubagents: live, codexTabKnownSubagents: known, codexDataModule,
    console: { log: (...args) => logs.push(args.join(' ')) },
    claudeBackgroundAgentActivity: { snapshot: () => ({ count: 0, agents: [] }) },
    getTerminalLifecycleGeneration: () => GENERATION,
    getCodexProcessActionGeneration: () => GENERATION,
    extractCodexLiveText: value => typeof value === 'string' ? value : '',
    findCodexAgentFile: () => null, isAgentFinishedByOwnTranscript: () => false,
    codexChildCompletionWatch: watcher,
    publishTabBackgroundWork: tabId => publications.push(context.getCombinedTabBackgroundWorkCount(tabId)),
  });
  vm.runInContext(source, context);
  const state = { tabId: TAB, sessionId: 'fixture-parent', processGeneration: GENERATION };
  watcher.reconcile(TAB, live.get(TAB) || new Map());
  return { agent, live, known, context, state, publications, logs, launchSettings,
    feed: row => context.trackCodexTabSubagentActivity(state, row),
    count: () => context.getCombinedTabBackgroundWorkCount(TAB),
    finish: at => { completion = { finished: true, completedAt: at }; callbacks.get('synthetic-child')?.(); },
    clear: () => watcher.clear(TAB),
  };
}

function savedCard() {
  const tracker = createCodexSubagentTracker();
  const card = tracker.registerSpawn({ callId: SPAWN, namespace: 'collaboration',
    toolName: 'spawn_agent', timestamp: new Date(START).toISOString(), args: { task_name: 'ui_modifier_reveal_e2e' } });
  tracker.onSubAgentActivity({ event_id: SPAWN, agent_path: NAME, agent_thread_id: CHILD,
    kind: 'started', model: 'gpt-6-luna', reasoning_effort: 'max' });
  tracker.absorbControlOutput({ namespace: 'multi_agent_v1', toolName: 'wait_agent', args: {} },
    JSON.stringify({ status: { [CHILD]: { completed: 'Own work completed' } } }), END);
  return { tracker, card };
}

test('actual Main: finished child -> QueueOnly call/interacted/output stays zero and keeps terminal metadata', () => {
  const h = liveHarness();
  h.feed(control()); h.feed(interacted()); h.feed(output());
  assert.equal(h.count(), 0);
  assert.deepEqual(h.publications, [], 'mail does not create spurious activity edges');
  assert.equal(h.agent.startedAt, START); assert.equal(h.agent.completedAt, END);
  assert.equal(h.agent.terminalStatus, 'completed');
  assert.strictEqual(h.agent.launchSettings, h.launchSettings);
  assert.equal(h.context.getTabTerminalCodexSubagents(TAB)[0].completedAt, END);
  h.clear();
});

test('saved tracker and its checkpoint: mailbox receipt does not reopen or restart the frozen clock', () => {
  const { tracker, card } = savedCard();
  const before = { start: card.startedAt, end: card.completedAt, duration: card.durationMs,
    settings: card.launchSettings };
  const restored = createCodexSubagentTracker(tracker.exportState());
  restored.onSubAgentActivity(interacted().payload, MAIL_TIME);
  assert.equal(restored.absorbControlOutput({ namespace: 'collaboration', toolName: 'send_message',
    args: { target: NAME }, timestamp: MAIL_TIME }, '', MAIL_TIME), true);
  assert.equal(card.subagentStatus, 'completed');
  assert.equal(card.startedAt, before.start); assert.equal(card.completedAt, before.end);
  assert.equal(card.durationMs, before.duration); assert.strictEqual(card.launchSettings, before.settings);
});

test('actual Main: mail to a genuinely running child preserves its lease and own completion still publishes zero', () => {
  const h = liveHarness({ active: true });
  h.feed(control()); h.feed(interacted()); h.feed(output());
  assert.equal(h.count(), 1); assert.equal(h.agent.startedAt, START);
  h.finish(END); assert.equal(h.count(), 0); assert.deepEqual(h.publications, [0]);
  assert.equal(h.agent.completedAt, END); h.clear();
});

test('actual Main and saved tracker: real followup reopens, old completion cannot close its new generation window', () => {
  const h = liveHarness();
  h.feed(control('followup_task', 'followup')); h.feed(interacted('followup')); h.feed(output('followup'));
  assert.equal(h.count(), 1); assert.equal(h.agent.startedAt, Date.parse(MAIL_TIME));
  h.finish(END); assert.equal(h.count(), 1, 'previous cycle is not terminal proof for new work');
  h.finish(Date.parse(MAIL_TIME) + 60_000); assert.equal(h.count(), 0);
  assert.strictEqual(h.agent.launchSettings, h.launchSettings); h.clear();
  const { tracker, card } = savedCard();
  tracker.absorbControlOutput({ namespace: 'collaboration', toolName: 'followup_task',
    args: { target: NAME }, timestamp: MAIL_TIME }, '', MAIL_TIME);
  assert.equal(card.subagentStatus, 'running'); assert.equal(card.completedAt, undefined);
});

test('actual Main: nested exec mail remains non-executing, while unknown target cannot replace another child', () => {
  const h = liveHarness();
  h.feed(record('response_item', { type: 'function_call', name: 'exec', call_id: 'exec-mail',
    arguments: JSON.stringify({ input: 'const r = await tools.collaboration__send_message({target: "' + NAME
      + '", message: "Mailbox only"}); text(r);' }) }));
  assert.equal(h.state.nativeSubagentCalls.get('exec-mail').logical[0].toolName, 'send_message');
  h.feed(output('exec-mail', ''));
  assert.ok(h.logs.some(line => line.includes('action=mail-no-turn')));
  h.feed(control('send_message', 'foreign', { arguments: JSON.stringify({ target: '/root/foreign' }) }));
  h.feed(interacted('foreign')); assert.equal(h.count(), 0);
  assert.equal(h.agent.completedAt, END); h.clear();
});

test('actual Main: a separate accepted spawn remains exact and mail cannot steal its child identity', () => {
  const h = liveHarness();
  h.feed(record('response_item', { type: 'function_call', name: 'spawn_agent', namespace: 'collaboration',
    call_id: 'spawn-B', arguments: JSON.stringify({ task_name: 'B' }) }));
  assert.equal(h.count(), 0, 'spawn call alone remains an attempt');
  h.feed(record('event_msg', { type: 'sub_agent_activity', kind: 'started', event_id: 'spawn-B',
    agent_path: '/root/B', agent_thread_id: 'child-B' }));
  assert.equal(h.count(), 1); assert.equal(h.live.get(TAB).get('spawn-B').threadId, 'child-B');
  h.feed(record('event_msg', { type: 'sub_agent_activity', kind: 'interacted', event_id: MAIL,
    agent_path: NAME, agent_thread_id: 'foreign-child' }));
  assert.equal(h.agent.threadId, CHILD); assert.equal(h.count(), 1);
  h.feed(record('event_msg', { type: 'sub_agent_activity', kind: 'started', event_id: SPAWN,
    agent_path: NAME, agent_thread_id: CHILD }));
  assert.equal(h.count(), 1, 'late initial start cannot resurrect an already terminal descriptor');
  h.clear();
});

test('v1 resume/send_input and nested real followup retain work-start behavior', () => {
  for (const name of ['resume_agent', 'send_input']) {
    const h = liveHarness();
    h.feed(control(name, name, { namespace: 'multi_agent_v1', arguments: JSON.stringify({ id: CHILD }) }));
    assert.equal(h.count(), 1, name); h.clear();
  }
  const h = liveHarness();
  h.feed(record('response_item', { type: 'function_call', name: 'exec', call_id: 'exec-followup',
    arguments: JSON.stringify({ input: 'const r = await tools.collaboration__followup_task({target: "' + NAME
      + '", message: "New work"}); text(r);' }) }));
  h.feed(output('exec-followup', ''));
  assert.equal(h.count(), 1); h.clear();
});

test('interacted/mail preserves interrupted, paused and unknown saved states, not just completed', () => {
  for (const status of ['interrupted', 'paused', 'unknown']) {
    const { tracker, card } = savedCard(); card.subagentStatus = status;
    tracker.onSubAgentActivity(interacted().payload, MAIL_TIME);
    tracker.absorbControlOutput({ namespace: 'collaboration', toolName: 'send_message',
      args: { target: NAME }, timestamp: MAIL_TIME }, '', MAIL_TIME);
    assert.equal(card.subagentStatus, status); assert.equal(card.completedAt, END);
  }
});

test('existing bounded own completion reader rejects old cycle and accepts the later exact terminal', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'noted-child-own-proof-'));
  const filePath = path.join(dir, 'synthetic-child.jsonl');
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const line = (timestamp, type) => JSON.stringify({ timestamp, type: 'event_msg', payload: { type } }) + '\n';
  await fs.promises.writeFile(filePath, line(new Date(END).toISOString(), 'task_complete'));
  assert.equal(readAgentCompletionProof({ toolType: 'codex', filePath, notBefore: START }).finished, true);
  assert.equal(readAgentCompletionProof({ toolType: 'codex', filePath, notBefore: Date.parse(MAIL_TIME) }).finished, false);
  await fs.promises.appendFile(filePath, line(MAIL_TIME, 'task_started'));
  assert.equal(readAgentCompletionProof({ toolType: 'codex', filePath, notBefore: START }).finished, false);
  const final = Date.parse(MAIL_TIME) + 60_000;
  await fs.promises.appendFile(filePath, line(new Date(final).toISOString(), 'task_complete'));
  assert.equal(readAgentCompletionProof({ toolType: 'codex', filePath, notBefore: Date.parse(MAIL_TIME) }).completedAt, final);
});

test('actual Main count feeds existing orchestration: finished -> mail -> parent done settles without a fabricated zero', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'noted-child-mail-regression-'));
  const store = new OrchestrationRunStore(path.join(dir, 'runs.json'));
  t.after(async () => { await store.flush(); await fs.promises.rm(dir, { recursive: true, force: true }); });
  await store.create({ runId: 'synthetic-mail', sourceTabId: 'fixture-4196', sourceProjectId: 'fixture',
    targetTabId: TAB, targetProjectId: 'fixture', targetToolType: 'codex', promptHash: 'synthetic', promptChars: 20 });
  await store.markDelivery('synthetic-mail', { lifecycleGeneration: GENERATION });
  await store.applyLifecycle(TAB, { type: 'busy', busy: true, lifecycleGeneration: GENERATION });
  const h = liveHarness(); h.feed(control()); h.feed(interacted()); h.feed(output());
  const result = await store.applyLifecycle(TAB, { type: 'done', reason: 'task_complete',
    lifecycleGeneration: GENERATION, backgroundWorkCount: h.count() });
  assert.equal((await store.get('synthetic-mail')).status, 'completed');
  assert.equal(result.settled.length, 1); h.clear();
});
