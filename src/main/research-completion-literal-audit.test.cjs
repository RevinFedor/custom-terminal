'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto'), ts = require('typescript')
const Database = require('better-sqlite3')
const { buildOrchestrationCompletionContent } = require('./orchestration-completion-content')
const { bindStructuredAuthoringPresentation } = require('./structured-authoring')
const { buildCodexImagePastePlan } = require('./codex-image-transport')
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint')
const { createAgentSendReceiptStore, STORE_STATES } = require('./agent-send-receipt-store')
const { projectCodexImageAuditToRequest } = require('./codex-image-request-projection')

function webPresentation() {
  const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8')
  const ast = ts.createSourceFile('web-server.js', source, ts.ScriptTarget.Latest, true)
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'orchestrationPresentationSnapshot')
  assert(fn)
  return vm.runInNewContext('(' + fn.getText(ast) + ')', { path, crypto, require, srcMainDir: __dirname })
}
function actualPublisher(store, routed) {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
  const begin = source.indexOf('function publishAgentPromptAuditResult(')
  const end = source.indexOf('\nfunction holdPasteAuditCompletionForTest(', begin)
  assert(begin >= 0 && end > begin)
  return vm.runInNewContext('(' + source.slice(begin, end) + ')', {
    console: { log() {}, warn() {}, error() {} }, agentSendReceiptStore: store,
    AGENT_SEND_DURABLE_STATES: STORE_STATES, projectCodexImageAuditToRequest,
    compatiblePromptAuditExecutionContext: () => ({ context: null, reason: 'owned-test' }),
    isOrchestrationPromptAudit: () => false, enrichCodexAuditAddress: () => {},
    routeAgentPromptAuditDetail: detail => routed.push(detail),
  })
}
test('actual Codex durable audit accepts one exact result with literal imagePath and does not create a false unconfirmed receipt', t => {
  const run = { runId: 'owned', runKind: 'external-research', status: 'completed', resultComplete: true,
    sourceTabId: 'tab', sourceSessionId: 'sid', targetTabName: 'ChatGPT', externalResearchJobId: 'job' }
  const answer = 'Example in expert answer: `[imagePath: /synthetic/example.png]`.\nFull Unicode: 𐐷\n'
  const content = buildOrchestrationCompletionContent(run, { success: true, assistantText: answer,
    externalResult: { artifacts: Array.from({ length: 13 }, () => ({})), artifact_errors: Array.from({ length: 8 }, () => ({})) } })
  const prompt = 'context\n' + content.prompt, snapshot = webPresentation()(run, 'completion', content, prompt)
  const bound = bindStructuredAuthoringPresentation(snapshot, prompt, prompt)
  let staged = 0
  const prepared = buildCodexImagePastePlan(prompt, () => { staged++; return { success: false } }, { authoringTransport: bound.authoringTransport })
  assert.equal(prepared.text, prompt); assert.equal(staged, 0)
  const legacy = buildCodexImagePastePlan(prompt, () => ({ success: false }))
  assert.notEqual(legacy.text, prompt); assert.match(legacy.text, /codex_image_path_unavailable/)

  const db = new Database(':memory:'); t.after(() => db.close())
  const store = createAgentSendReceiptStore(db, { randomUUID: () => 'attempt' })
  const identity = { operationKey: 'history:tab:completion:owned', handoffId: 'completion:owned', surface: 'desktop-history',
    requestFingerprint: 'owned', tabId: 'tab', provider: 'codex', sessionId: 'sid',
    promptHash: promptAuditFingerprint(prompt), promptLength: prompt.length }
  const initial = store.beginAttempt(identity); assert.equal(initial.action, 'attempt-started')
  store.settleAttempt(identity.operationKey, initial.attemptId, { submitted: true, auditPending: true, status: 'audit-pending' })
  const audit = { handoffId: identity.handoffId, sendOperationKey: identity.operationKey, sendAttemptId: initial.attemptId,
    expectedHash: promptAuditFingerprint(prepared.text), expectedLen: prepared.text.length, expectedText: prepared.text }
  const result = { success: true, actualHash: promptAuditFingerprint(prepared.text), actualLen: prepared.text.length,
    expectedHash: audit.expectedHash, expectedLen: audit.expectedLen, sessionId: 'sid',
    sourceIdentity: 'codex-user-sid', entryUuid: 'own-user', auditTimestamp: '2026-10-27T03:20:47.000Z' }
  const routed = [], publish = actualPublisher(store, routed)
  publish('tab', audit, result, 'codex')
  assert.equal(store.get(identity.operationKey).state, 'confirmed')
  assert.equal(routed.length, 1); assert.equal(routed[0].success, true)
  assert.equal(routed[0].expectedHash, identity.promptHash)
})
