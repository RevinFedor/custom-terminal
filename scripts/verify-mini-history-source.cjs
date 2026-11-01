'use strict';
// Actual shared History/Timeline projectors over OWN completed fixtures only.
// Does not exercise Electron pixels, Main IPC or any user's original History.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const profileFile = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../docs/tmp/мини-оркестратор-20261030/replay/ready-v2/PROFILE.json');
const folder = path.dirname(profileFile);
const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
process.env.CODEX_HOME = path.join(profile.root, 'codex');
const { _api } = require('../src/main/ipc/codex-data');
const result = [];
for (const c of profile.cases) {
  const proof = JSON.parse(fs.readFileSync(c.actualGeminiResult.nativeProof, 'utf8'));
  const bytes = fs.readFileSync(c.sessionFile); assert.ok(bytes.length < 32 * 1024 * 1024);
  const records = bytes.toString().trimEnd().split('\n').map((line, index) => ({ ...JSON.parse(line), __line: index }));
  const timeline = _api.buildCodexTimeline(records, c.sessionId);
  const history = _api.buildCodexFullHistory(records, c.sessionId);
  const selected = timeline.filter(e => e.uuid === proof.user.id);
  assert.equal(selected.length, 1, 'exact canonical request must be one timeline entry');
  const sourceCase = JSON.parse(fs.readFileSync(c.sourceCase, 'utf8'));
  const additional = sourceCase.additionalInputsFile ? JSON.parse(fs.readFileSync(sourceCase.additionalInputsFile, 'utf8')) : [];
  for (const input of additional) {
    const rows = timeline.filter(e => e.uuid === input.id);
    assert.equal(rows.length, 1, 'exact same-turn clarification must remain one entry');
    const event = records[input.rawLine];
    assert.equal(event.payload?.message, input.text, 'clarification body is the literal native source');
  }
  const answer = history.find(e => e.uuid === proof.final.id);
  assert.ok(answer, 'exact native final must be visible in shared History');
  assert.equal(answer.role, 'assistant');
  assert.equal(String(answer.content).trim(), proof.final.text.trim());
  result.push({ tabId: c.tabId, sessionId: c.sessionId, historyRows: history.length, timelineRows: timeline.length,
    exactRequestCount: selected.length, exactClarificationCount: additional.length, exactFinalFound: true, nativeProvider: true, projection: 'actual-source', GUI: 'NOTRUN' });
}
fs.writeFileSync(path.join(folder, 'HISTORY-SOURCE-VERIFICATION.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
console.log('[MiniReady] actual History/Timeline source verified ' + result.length + ' completed native sessions');
