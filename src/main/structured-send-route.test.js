'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const http = require('node:http');
const crypto = require('node:crypto');
const { prepareStructuredAuthoring, validateStructuredSendEnvelope, bindStructuredAuthoringPresentation } = require('./structured-authoring');
const { createAgentSendReceiptRegistry, fingerprintAgentSendRequest, RECEIPT_STATES, isAgentSendProviderQueueAccepted } = require('./agent-send-receipt-registry');
const { classifyAgentSendReceipt } = require('./orchestration-runs');
const { agentSendTargetPreconditionFailure } = require('./agent-send-target-precondition');
const { withPromptOriginPresentation } = require('./history-prompt-presentations');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { buildCodexImagePastePlan } = require('./codex-image-transport');
const { prepareClaudePromptTransport } = require('./claude-prompt-transport');

const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const tree = ts.createSourceFile('web.js', source, ts.ScriptTarget.Latest, true);
const fn = name => {
  const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, name); return node.getText(tree);
};
const routeSource = source.slice(source.indexOf('  // Send prompt to a project terminal tab.'),
  source.indexOf("  m = parsed.pathname.match(/^\\/api\\/terminal-tabs\\/([^/]+)\\/completion-notification"));

async function harness({ loseReply = false } = {}) {
  const calls = [], prefix = 'current pending context\n\n';
  let target = { tabId: 'T', sessionId: 'S', toolType: 'codex', projectId: 'P', tabType: 'terminal' };
  const sendJson = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const context = vm.createContext({
    console: { log() {}, warn() {} }, crypto, prepareStructuredAuthoring, validateStructuredSendEnvelope, bindStructuredAuthoringPresentation,
    promptAuditFingerprint, fingerprintAgentSendRequest, withPromptOriginPresentation, agentSendTargetPreconditionFailure,
    AGENT_SEND_RECEIPT_STATES: RECEIPT_STATES, agentSendReceiptRegistry: createAgentSendReceiptRegistry(),
    agentSendReceiptStartupReady: Promise.resolve(), agentSendReceiptStore: null, agentSendBridgeTimeoutMs: 1000,
    classifyAgentSendReceipt, isAgentSendProviderQueueAccepted, projectManager: {},
    shortId: value => value, cleanOptionalString: (value, fallback = '') => typeof value === 'string' ? value.trim() : fallback,
    decId: decodeURIComponent, sendJson,
    readBody: req => new Promise((resolve, reject) => {
      let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }),
    findOrchestrationTabDescriptor: () => target,
    findRestorableAgentTabDescriptor: () => { throw Error('unexpected archive restore'); },
    ensureExplicitAgentTabOpen: async () => { calls.push(['prepareSend']); return { descriptor: target }; },
    resolveProjectAgentModelRequest: async () => ({ model: undefined }),
    resolveSendPromptPresentation: async (_manager, _body, prompt) => {
      calls.push(['legacy-resolve']); return { prompt, promptChips: [], contextFiles: [] };
    },
    normalizeSendAttachments: attachments => Array.isArray(attachments) ? attachments : [],
    tabWorkContext: { prepare: async (_tab, _handoff, prompt) => { calls.push(['context-prepare']); return { prompt: prefix + prompt }; },
      activate() {}, settle() {}, release() {} },
    bridgeRequest: async (action, payload) => {
      assert.equal(action, 'sendAgentPromptScenario'); calls.push(['bridge', payload]);
      assert.equal(payload.workContextPrepared, true);
      if (loseReply) throw Object.assign(Error('reply lost'), { code: 'bridge_timeout' });
      const staged = [];
      if (target.toolType === 'claude') {
        const claudeSource = fs.readFileSync(path.join(__dirname, '../renderer/utils/claudePtyActions.ts'), 'utf8');
        const claudeTree = ts.createSourceFile('claude.ts', claudeSource, ts.ScriptTarget.Latest, true);
        const node = claudeTree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'sendClaudePtyPrompt');
        const functionCode = ts.transpileModule(node.getText(claudeTree).replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
        const sender = vm.runInNewContext(functionCode + ';sendClaudePtyPrompt', {
          sendInflight: new Map(), useWorkspaceStore: { getState: () => ({ clearInterruptedState() {} }) },
          console: { log() {}, warn() {} }, shortTab: x => x, errorText: e => e.message,
          isStandaloneAgentLocalCommand: () => null,
          ipcRenderer: { invoke: async (channel, input) => {
            assert.equal(channel, 'terminal:paste');
            assert.equal(input.content, payload.prompt);assert.equal(input.submit, true);
            assert.equal(input.verifyClaudeVisibleDraftBeforePaste, true);
            assert.equal(input.presentationSnapshot, payload.presentationSnapshot);
            calls.push(['claude-paste', input, prepareClaudePromptTransport(input.content)]);
            return { success: true };
          } },
        });
        await sender('T', payload.prompt, { ...payload, source: 'test-structured-authoring' });
      } else buildCodexImagePastePlan(payload.prompt, file => { staged.push(file); return { success: true, path: file, inputPath: '/alias/' + path.basename(file) }; }, {
        authoringTransport: payload.presentationSnapshot?.authoringTransport || null,
      });
      calls.push(['staging', staged]);
      return { success: true, submitted: true, accepted: true, status: 'sent',
        exactAuditConfirmed: true, pasteAudit: { success: true, actualHash: promptAuditFingerprint(payload.prompt), auditTimestamp: '2026-09-13T00:00:00Z' } };
    },
    sendSendFailure: (res, data) => sendJson(res, 409, data),
    sendDeliveryUnknown: (res, data) => sendJson(res, 202, data),
    sendAuditPending: (res, data) => sendJson(res, 202, data),
  });
  vm.runInContext([fn('appendAttachmentsToPrompt'), fn('runAgentSendScenario'), fn('runPreparedAgentSendScenario')].join('\n'), context);
  const run = vm.runInContext('(async (req,res,parsed)=>{ let m; ' + routeSource + '})', context);
  const server = http.createServer((req, res) => run(req, res, { pathname: req.url }).catch(e => sendJson(res, 500, { error: e.message })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, prefix, setTarget: value => { target = value; },
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }),
    post: async body => {
      const res = await fetch('http://127.0.0.1:' + server.address().port + '/api/terminal-tabs/T/send', { method: 'POST', body: JSON.stringify(body) });
      return { status: res.status, data: await res.json() };
    } };
}

const request = () => ({ handoffId: 'one-new-explicit-send', expectedSessionId: 'S', expectedToolType: 'codex',
  authoring: { version: 1, parts: [{ kind: 'text', text: 'user ' }, { kind: 'paste', chipId: 'p' },
    { kind: 'image', imageId: 7 }], chips: [
    { id: 'rules', kind: 'prompt', label: 'Rules', text: 'instructions', sourceKey: 'library-original', contextUpdateId: 'same-update' },
    { id: 'p', kind: 'paste', text: 'pasted body' },
  ], imagePaths: [{ id: 7, path: '/fixture/image.png' }] } });

test('actual public /send -> common context/send/registry -> existing bridge, one image staging', async () => {
  const h = await harness();
  try {
    const body = request();
    const first = await h.post(body);
    assert.equal(first.status, 200, JSON.stringify(first));
    const payload = h.calls.find(call => call[0] === 'bridge')[1];
    assert.equal(payload.prompt.startsWith(h.prefix), true);
    assert.match(payload.prompt, /<saved_prompt name="Rules" context-update-id="same-update">/);
    assert.equal(payload.presentationSnapshot.promptChips[0].sourceKey, 'library-original');
    assert.equal(payload.authoringSnapshot.parts[1].chipId, 'p');
    assert.match(payload.authoringSnapshot.editorText, /Pasted Content/);
    assert.deepEqual(h.calls.find(call => call[0] === 'staging')[1], ['/fixture/image.png']);
    assert.equal(h.calls.some(call => call[0] === 'legacy-resolve'), false);
    assert.equal((await h.post(body)).status, 200);
    assert.equal(h.calls.filter(call => call[0] === 'bridge').length, 1);
    body.authoring.chips[0].sourceKey = 'different-library';
    const conflict = await h.post(body);
    assert.equal(conflict.status, 409, JSON.stringify(conflict));
    assert.equal(conflict.data.code, 'agent_send_handoff_conflict');
    assert.equal(h.calls.filter(call => call[0] === 'bridge').length, 1);
  } finally { await h.close(); }
});

test('normal plain /send and its legacy uploaded attachment prefix are unchanged', async () => {
  const h = await harness();
  try {
    const reply = await h.post({ prompt: ' plain prompt ', handoffId: 'legacy', attachments: [{ kind: 'image', path: '/upload.png' }] });
    assert.equal(reply.status, 200, JSON.stringify(reply));
    assert.equal(h.calls.some(call => call[0] === 'legacy-resolve'), true);
    const payload = h.calls.find(call => call[0] === 'bridge')[1];
    assert.equal(payload.prompt, h.prefix + '[imagePath: /upload.png]\n\nplain prompt');
    assert.equal(payload.authoringSnapshot, undefined);
  } finally { await h.close(); }
});

test('Claude structured authoring uses the same serializer/send/receipt route, including explicit first-send null SID', async () => {
  const h = await harness();
  try {
    h.setTarget({ tabId:'T',sessionId:'S',toolType:'claude',projectId:'P',tabType:'terminal' });
    const body=request();body.expectedToolType='claude';
    const result=await h.post(body);assert.equal(result.status,200,JSON.stringify(result));
    const payload=h.calls.find(call=>call[0]==='bridge')[1];
    assert.equal(payload.expectedToolType,'claude');assert.equal(payload.authoringSnapshot.chips[0].sourceKey,'library-original');
    assert.equal(h.calls.some(call=>call[0]==='legacy-resolve'),false);
    assert.equal((await h.post(body)).status,200);assert.equal(h.calls.filter(call=>call[0]==='bridge').length,1);
    assert.equal(h.calls.filter(call=>call[0]==='claude-paste').length,1);
    assert.equal(h.calls.find(call=>call[0]==='claude-paste')[2].raw.text,payload.prompt);
    assert.equal(h.calls.find(call=>call[0]==='claude-paste')[1].presentationSnapshot.imagePaths.length,1);
    h.setTarget({tabId:'T',sessionId:null,toolType:'claude',projectId:'P',tabType:'terminal'});
    const fresh=await h.post({...body,handoffId:'fresh-after-file-deleted',expectedSessionId:null});
    assert.equal(fresh.status,200,JSON.stringify(fresh));
    assert.equal(h.calls.filter(call=>call[0]==='bridge').length,2);
  } finally {await h.close();}
});

test('invalid DTO/mixed attachments fail before context preparation, restore or bridge', async () => {
  const h = await harness();
  try {
    const body = request(); body.attachments = [{ kind: 'image', path: '/duplicate.png' }];
    const result = await h.post(body);
    assert.equal(result.status, 400);
    assert.equal(result.data.submitted, false);
    assert.equal(result.data.enterWritten, false);
    assert.deepEqual(h.calls, []);
  } finally { await h.close(); }
});

test('the existing expected-session guard still rejects another writer before bridge', async () => {
  const h = await harness();
  try {
    h.setTarget({ tabId: 'T', sessionId: 'different', toolType: 'codex', projectId: 'P' });
    const result = await h.post(request());
    assert.equal(result.status, 409);
    assert.equal(result.data.submitted, false);
    assert.equal(h.calls.some(call => call[0] === 'bridge'), false);
  } finally { await h.close(); }
});

test('lost bridge receipt stays unknown and never retries the structured prompt', async () => {
  const h = await harness({ loseReply: true });
  try {
    const body = request();
    assert.equal((await h.post(body)).status, 202);
    assert.equal((await h.post(body)).status, 202);
    assert.equal(h.calls.filter(call => call[0] === 'bridge').length, 1);
  } finally { await h.close(); }
});
