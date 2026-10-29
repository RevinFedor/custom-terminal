// Reusable native-input fixtures for the retained catalog and frozen oracle.
// These create fresh references on every invocation; do not JSON-normalize them.
export const fixtureEpoch = Date.parse('2026-10-27T12:00:00.000Z');
export const agentRow = (uuid, actions = [], extra = {}) => ({
  uuid, role: 'assistant', sessionId: 'session', timestamp: new Date(fixtureEpoch).toISOString(),
  actions, ...extra,
});
export const taskAction = (toolUseId, extra = {}) => ({ tool: 'Task', toolUseId, description: toolUseId, ...extra });
export const catalogScope = (extra = {}) => ({
  isTurnBusy: false, agentProcessAlive: false, currentSessionId: 'session',
  currentProcessGeneration: 'generation', chipToolType: 'codex',
  exactActiveSubagents: null, exactActiveBackgroundTasks: null, terminalBackgroundTaskCalls: null,
  ...extra,
});
export function literalCatalog(oracle, entries, scope = catalogScope(), terminalFacts) {
  const background = oracle.collectHistoryBackgroundChips(entries, scope.isTurnBusy,
    scope.agentProcessAlive, scope.currentSessionId, scope.currentProcessGeneration,
    scope.chipToolType, scope.exactActiveSubagents, scope.exactActiveBackgroundTasks,
    scope.terminalBackgroundTaskCalls);
  return { background, agents: oracle.collectHistoryAgentChips(entries, background, terminalFacts) };
}
export function farHistoryFixture(count = 901) {
  return Array.from({ length: count }, (_, index) => agentRow('row-' + index, [], {
    rowStub: true, actionSummary: [{ toolName: 'Task', family: 'task', toolUseId: 'agent-' + index,
      description: 'historical ' + index, startedAt: index + 1,
      subagentStatus: index % 2 ? 'interrupted' : 'completed' }],
  }));
}
export function duplicateLiveFixture() {
  const first = agentRow('first', [taskAction('dup', { startedAt: 10,
    history: [{ type: 'text', content: 'first history' }], result: 'retained result', taskPrompt: 'first prompt' })]);
  const second = agentRow('second', [taskAction('dup', { startedAt: 20, description: 'last row',
    history: [], result: undefined, taskPrompt: '' })]);
  const live = [{ key: 'task:dup', kind: 'subagent', label: 'live label', entryUuid: 'live',
    startedAt: 99, status: 'running', agentId: 'current-id' }];
  return { entries: [first, second], live, first, second };
}
export function fullNativeFixture() {
  const full = ('FULL\0\ud800\ud83d\ude42\uffff' + '文'.repeat(32)).repeat(4096) + 'EXACT-END';
  const history = [{ type: 'text', content: full, tools: ['tool\udfff'] }];
  const launchSettings = { provider: 'codex', model: full, effort: 'high', nested: { value: full } };
  const action = taskAction('full', { description: full, taskPrompt: full, result: full, history,
    agentSessionId: full, agentId: full, launchSettings, subagentStatus: 'completed' });
  const row = agentRow('uuid-' + full, [action]);
  return { entries: [row], row, action, full, history, launchSettings };
}
export function nativeGrammarFixture() {
  const coercions = [];
  const toolUseId = Object.create({ [Symbol.toPrimitive](hint) { coercions.push('id:' + hint); return 'native-key'; } });
  const startedAt = Object.create({ valueOf() { coercions.push('start'); return 5n; } });
  const timestamp = { toString() { coercions.push('time'); return '2026-10-27T12:00:00.000Z'; } };
  const history = new Uint16Array([0, 0xd800, 0xffff]);
  const action = Object.assign(Object.create({ tool: 'Task', description: 'inherited' }), {
    toolUseId, startedAt, result: false, history,
  });
  const actions = new Array(5);
  actions[1] = undefined; actions[3] = action;
  return { entries: [agentRow('native', actions, { timestamp })], action, history, coercions };
}
