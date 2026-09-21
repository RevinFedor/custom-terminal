'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { promptAuditFingerprint } = require('../prompt-audit-fingerprint');
const { _api } = require('./claude-data');
const source = fs.readFileSync(require.resolve('./claude-data'), 'utf8');
const ast = ts.createSourceFile('claude-data.js', source, ts.ScriptTarget.Latest, true);
let normalizer = null;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name?.getText(ast) === 'normalizeQueuedText') {
    normalizer = node.initializer.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const start = source.indexOf("        if (entry.type === 'user') {", source.indexOf('_api.getFullHistory ='));
const end = source.indexOf(" else if (entry.type === 'assistant')", start);
assert.ok(start > 0 && end > start && normalizer);

for (const arrayCarrier of [false, true]) {
  test('actual full History user branch retains the pre-normalization audit hash: ' + (arrayCarrier ? 'text parts' : 'string'), () => {
    const raw = '\n\n<pasted_content id="native-1">\nordinary user text\n</pasted_content id="native-1">\n';
    const record = { type: 'user', uuid: 'U', sessionId: 'S', timestamp: '2026-09-20T13:45:02.107Z',
      __byteOffset: 17982635, message: { content: arrayCarrier
        ? [{ type: 'text', text: raw.slice(0, 20) }, { type: 'text', text: raw.slice(20) }] : raw } };
    const original = JSON.stringify(record);
    const rows = [];
    vm.runInNewContext('const normalizeQueuedText = ' + normalizer + ';\n'
      + 'for (let i = 0; i < records.length; i++) { const entry = records[i]; const entrySid = entry.sessionId;\n'
      + source.slice(start, end) + '\n}', {
      records: [record], promptAuditFingerprint, claudeUserRecordText: _api.claudeUserRecordText,
      shouldSkipPromptText: () => false, takeMatchingQueuedEntry: () => null,
      isClaudeCompactSummaryCandidate: () => false, slashCommandEntryFromText: () => null,
      appendProjectedEntry: entry => rows.push(entry),
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, raw.trim());
    assert.equal(rows[0].promptPresentationTransportHash, promptAuditFingerprint(raw));
    assert.notEqual(rows[0].promptPresentationTransportHash, promptAuditFingerprint(rows[0].content));
    assert.equal(rows[0].recordByteOffset, 17982635);
    assert.equal(JSON.stringify(record), original, 'the source record is never rewritten');
  });
}
