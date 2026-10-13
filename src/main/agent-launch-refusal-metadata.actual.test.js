'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const root = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'runCodexCommandFromPayloadInner');
function branch(condition) {
  let found;
  const visit = node => {
    if (ts.isIfStatement(node) && node.expression.getText(ast) === condition) found = node.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(root); assert.ok(found); return found;
}
for (const condition of ['!preLaunchAdmission.allowed', '!boundary.written']) {
  test('actual Codex no-launch return preserves lookup reason without inventing no-paste: ' + condition, () => {
    const admission = { allowed: false, reason: 'process_lookup_unknown', lookup: { status: 'unknown', matches: [] } };
    let rolledBack = false;
    const result = vm.runInNewContext('(function(){' + branch(condition) + '})()', {
      preLaunchAdmission: admission, boundary: { written: false, admission }, tabId: 'T',
      AI_PROCESS_LOOKUP_STATUS: { UNKNOWN: 'unknown' }, console: { warn() {} },
      agentShellLaunchError: () => 'shell_not_idle', ownsMcpStartupRecoveryHandoff: false,
      rollbackLaunchSetup: () => { rolledBack = true; },
    });
    assert.equal(result.launchWritten, false); assert.equal(result.accepted, false);
    assert.equal(result.reason, 'process_lookup_unknown'); assert.equal(result.lookupUnknown, true);
    assert.equal(result.pasteWritten, undefined); assert.equal(result.enterWritten, undefined);
    assert.equal(rolledBack, condition === '!boundary.written');
  });
}
