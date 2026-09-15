'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createClaudeSettingEvidence } = require('./claude-setting-evidence');

const COMMAND = '/effort max';
const line = value => JSON.stringify(value) + '\n';
const anchor = (uuid = 'anchor-a', sessionId = 'session-a') => ({ type: 'assistant', uuid, sessionId,
  message: { role: 'assistant', content: 'source boundary' } });
function wrapper(uuid, { sessionId = 'session-a', value = 'max', command = 'effort', parentUuid = 'anchor-a', system = false } = {}) {
  const content = `<command-name>/${command}</command-name>\n<command-message>${command}</command-message>\n<command-args>${value}</command-args>`;
  return { uuid, sessionId, parentUuid, timestamp: '1999-01-01T00:00:00Z',
    ...(system ? { type: 'system', subtype: 'local_command', content }
      : { type: 'user', message: { role: 'user', content } }) };
}
function output(parentUuid, { uuid = parentUuid + '-out', sessionId = 'session-a', text = 'Set effort level to max', system = false } = {}) {
  const content = `<local-command-stdout>${text}</local-command-stdout>`;
  return { uuid, sessionId, parentUuid, timestamp: '1999-01-01T00:00:00Z',
    ...(system ? { type: 'system', subtype: 'local_command', content }
      : { type: 'user', message: { role: 'user', content } }) };
}

function harness(t, options = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-setting-evidence-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const file = path.join(scratch, 'session-a.jsonl');
  if (options.initial !== null) fs.writeFileSync(file, options.initial ?? line(anchor()));
  let active = true;
  let counter = 0;
  let owner = { term: { privateTerminalObject: true }, terminalInstanceId: 'terminal-a',
    lifecycleGeneration: 'generation-a', runSeq: 3, launchId: 'launch-a', pid: 123,
    inputRevision: 9, freshLaunch: false, ...options.owner };
  let binding = options.binding === null ? null : { sessionId: 'session-a', filePath: file };
  const service = createClaudeSettingEvidence({ captureOwner: () => owner,
    isOwnerCurrent: (_tab, captured) => active && captured.term === owner.term
      && captured.lifecycleGeneration === owner.lifecycleGeneration,
    resolveBinding: () => binding, uuid: () => 'id-' + (++counter), now: () => 1000,
    ...options.factory });
  const admit = (command = COMMAND) => service.admit({ tabId: 'tab-a', command, operationId: 'operation-' + (++counter) });
  const write = token => {
    assert.equal(service.prepareWrite(token, 'paste').allowed, true);
    assert.equal(service.markWritten(token, 'paste'), true);
    assert.equal(service.prepareWrite(token, 'enter').allowed, true);
    assert.equal(service.markWritten(token, 'enter'), true);
  };
  const read = (token, extra = {}) => service.read({ tabId: token.tabId, command: token.command,
    commandId: token.commandId, sessionId: binding?.sessionId || null, ...extra });
  const append = (...records) => fs.appendFileSync(file, records.map(line).join(''));
  return { scratch, file, service, admit, write, read, append,
    setActive: value => { active = value; }, setOwner: value => { owner = { ...owner, ...value }; },
    setBinding: value => { binding = value; }, getOwner: () => owner };
}

test('private token membership, exact lookup, single Enter admission and safe snapshots', async t => {
  const h = harness(t);
  const token = h.admit();
  assert.equal(h.service.get(token.commandId, { tabId: 'tab-a', command: COMMAND }), token);
  assert.equal(h.service.get(token.commandId, { tabId: 'wrong', command: COMMAND }), null);
  assert.equal(h.service.get(token.commandId, { tabId: 'tab-a', command: '/effort low' }), null);
  assert.equal(h.service.prepareWrite({ ...token }, 'enter').allowed, false);
  assert.equal(h.service.markWritten(token, 'enter'), false);
  assert.equal((await h.read(token)).reason, 'write-not-prepared');
  h.write(token);
  assert.equal(h.service.prepareWrite(token, 'enter').reason, 'enter-already-armed');
  assert.equal(h.service.prepareWrite(token, 'paste').allowed, false);
  const snapshot = (await h.read(token)).evidence;
  assert.equal(snapshot.owner.term, undefined);
  assert.ok(!JSON.stringify(snapshot).includes('privateTerminalObject'));
  assert.equal(snapshot.owner.inputRevision, 9);
  assert.ok(snapshot.checkpoint.offset > 0);
  assert.equal(snapshot.checkpoint.enterOffset, snapshot.checkpoint.offset);
});

test('old same-command success/rejection and late old stdout cannot prove the new command', async t => {
  const initial = line(anchor()) + line(wrapper('old-success')) + line(output('old-success'))
    + line(wrapper('old-failure')) + line(output('old-failure', { text: 'API error: 429 rate limit' }));
  const h = harness(t, { initial });
  const token = h.admit(); h.write(token);
  h.append(output('old-success', { uuid: 'late-old-success' }), output('old-failure', { uuid: 'late-old-rejection' }));
  assert.equal((await h.read(token)).success, false);
  h.append(wrapper('current'), output('current'));
  const proof = await h.read(token);
  assert.equal(proof.success, true);
  assert.equal(proof.wrapperUuid, 'current');
  assert.equal(proof.stdoutUuid, 'current-out');
  assert.equal(proof.commandId, token.commandId);
});

test('withheld Enter cannot prove anything; a pre-Enter wrapper remains old after Enter eventually happens', async t => {
  const h = harness(t);
  const token = h.admit();
  const prepared = h.service.prepareWrite(token, 'paste');
  h.service.markWritten(token, 'paste');
  h.append(wrapper('before-enter'), output('before-enter'));
  assert.equal((await h.read(token)).reason, 'enter-withheld');
  assert.equal(h.service.prepareWrite(token, 'enter').allowed, true);
  h.service.markWritten(token, 'enter');
  assert.equal((await h.read(token)).success, false);
  h.append(wrapper('after-enter'), output('after-enter'));
  const proof = await h.read(token);
  assert.equal(proof.success, true);
  assert.equal(proof.wrapperUuid, 'after-enter');
  assert.equal(proof.evidence.checkpoint.offset, prepared.evidence.checkpoint.offset);
  assert.ok(proof.evidence.checkpoint.enterOffset > proof.evidence.checkpoint.offset);
});

test('only a later direct same-SID child of a valid carrier proves the bound wrapper', async t => {
  const h = harness(t);
  const token = h.admit(); h.write(token);
  h.append(output('current', { uuid: 'before-wrapper' }),
    { ...wrapper('assistant-forgery'), type: 'assistant', message: { role: 'assistant', content: wrapper('x').message.content } },
    output('assistant-forgery'), wrapper('current', { system: true }),
    output('current', { uuid: 'wrong-session', sessionId: 'other' }),
    { ...output('not-direct', { uuid: 'logical-only' }), logicalParentUuid: 'current' });
  assert.equal((await h.read(token)).success, false);
  h.append(output('current', { system: true }));
  const proof = await h.read(token);
  assert.equal(proof.success, true);
  assert.equal(proof.stdoutUuid, 'current-out');
});

test('re-emitting a wrapper UUID from the admitted baseline does not make it new', async t => {
  const h = harness(t, { initial: line(anchor()) + line(wrapper('old')) + line(output('old')) });
  const token = h.admit(); h.write(token);
  h.append(wrapper('old'), output('old', { uuid: 'duplicate-old-result' }));
  assert.equal((await h.read(token)).success, false);
  h.append(wrapper('new'), output('new'));
  assert.equal((await h.read(token)).wrapperUuid, 'new');
});

test('partial baseline line is skipped; newly started partial lines survive incremental reads', async t => {
  const old = line(wrapper('partial-old'));
  const h = harness(t, { initial: line(anchor()) + old.slice(0, 30) });
  const token = h.admit(); h.write(token);
  fs.appendFileSync(h.file, old.slice(30) + line(output('partial-old')) + line(wrapper('new')));
  const child = line(output('new'));
  fs.appendFileSync(h.file, child.slice(0, 31));
  const first = await h.read(token);
  assert.equal(first.success, false);
  assert.equal(first.evidence.checkpoint.wrapperUuid, 'new');
  fs.appendFileSync(h.file, child.slice(31));
  assert.equal((await h.read(token)).success, true);
});

test('bound wrapper survives more than 512 KiB of unrelated complete output across reads', async t => {
  const h = harness(t);
  const token = h.admit(); h.write(token);
  h.append(wrapper('current'));
  assert.equal((await h.read(token)).evidence.checkpoint.wrapperUuid, 'current');
  const noise = line({ type: 'assistant', uuid: 'noise', sessionId: 'session-a', message: { role: 'assistant', content: 'а'.repeat(2000) } });
  fs.appendFileSync(h.file, noise.repeat(350));
  h.append(output('current'));
  assert.ok(fs.statSync(h.file).size > 512 * 1024);
  assert.equal((await h.read(token)).success, true);
});

test('a single read streams a large gap rather than searching a fixed tail', async t => {
  const h = harness(t);
  const token = h.admit(); h.write(token);
  h.append(wrapper('current'));
  fs.appendFileSync(h.file, line({ type: 'noise', text: 'x'.repeat(1100000) }));
  h.append(output('current'));
  assert.equal((await h.read(token)).success, true);
});

test('unbound previous Enter makes BOTH identical commands ambiguous, never FIFO matched', async t => {
  const h = harness(t);
  const first = h.admit(); h.write(first);
  const second = h.admit('/effort MAX'); h.write(second);
  h.append(wrapper('could-be-either'), output('could-be-either'));
  for (const token of [first, second]) {
    const proof = await h.read(token);
    assert.equal(proof.success, false);
    assert.equal(proof.reason, 'ambiguous-prior-command');
    assert.equal(proof.evidence.ambiguousCommandIds.length, 1);
  }
  assert.equal(h.service.prepareWrite(second, 'enter').allowed, false);
});

test('pre-existing wrapper is bound to prior command during admission even before its stdout', async t => {
  const h = harness(t);
  const first = h.admit(); h.write(first);
  h.append(wrapper('first'));
  const second = h.admit(); h.write(second);
  h.append(output('first'), wrapper('second'), output('second'));
  assert.equal((await h.read(first)).wrapperUuid, 'first');
  assert.equal((await h.read(second)).wrapperUuid, 'second');
});

test('bounded sync prior scan may defer, then exact pre-admission position releases ambiguity', async t => {
  const h = harness(t);
  const first = h.admit(); h.write(first);
  fs.appendFileSync(h.file, line({ type: 'noise', content: 'x'.repeat(700000) }));
  h.append(wrapper('first'));
  const second = h.admit(); h.write(second);
  h.append(output('first'), wrapper('second'), output('second'));
  const unresolved = await h.read(second);
  assert.equal(unresolved.reason, 'ambiguous-prior-command');
  assert.equal((await h.read(first)).wrapperUuid, 'first');
  assert.equal((await h.read(second)).wrapperUuid, 'second');
});

test('a previous pasted but withheld command cannot poison the next explicit command', async t => {
  const h = harness(t);
  const first = h.admit(); h.service.prepareWrite(first, 'paste'); h.service.markWritten(first, 'paste');
  const second = h.admit(); h.write(second);
  h.append(wrapper('second'), output('second'));
  assert.equal((await h.read(first)).reason, 'enter-withheld');
  assert.equal((await h.read(second)).success, true);
});

test('verified late fresh binding/file creation may use zero only in the admitted fresh launch', async t => {
  const h = harness(t, { initial: null, binding: null, owner: { freshLaunch: true } });
  const token = h.admit(); h.write(token);
  assert.equal((await h.read(token)).reason, 'writer-binding-pending');
  h.setBinding({ sessionId: 'session-a', filePath: h.file });
  assert.equal((await h.read(token)).reason, 'writer-file-pending');
  fs.writeFileSync(h.file, line(wrapper('fresh')) + line(output('fresh')));
  const proof = await h.read(token);
  assert.equal(proof.success, true);
  assert.equal(proof.evidence.checkpoint.offset, null);
});

test('non-fresh delayed file without source lineage is unknown, not offset-zero proof', async t => {
  const h = harness(t, { initial: null, binding: null });
  const token = h.admit(); h.write(token);
  fs.writeFileSync(h.file, line(wrapper('old-copy')) + line(output('old-copy')));
  h.setBinding({ sessionId: 'session-a', filePath: h.file });
  const proof = await h.read(token);
  assert.equal(proof.success, false);
  assert.equal(proof.reason, 'lineage-unknown');
});

test('resume to copied new writer needs exact source EOF anchor hash before recognizing new records', async t => {
  const h = harness(t);
  h.setOwner({ sourceBaseline: { sessionId: 'session-a', filePath: h.file } });
  h.setBinding(null);
  const token = h.admit(); h.write(token);
  const child = path.join(h.scratch, 'child.jsonl');
  fs.writeFileSync(child, line(wrapper('old-copy', { sessionId: 'child', parentUuid: 'older-than-anchor' }))
    + line(output('old-copy', { sessionId: 'child' })) + line(anchor())
    + line(wrapper('new', { sessionId: 'child' })) + line(output('new', { sessionId: 'child' })));
  h.setBinding({ sessionId: 'child', filePath: child });
  const proof = await h.read(token);
  assert.equal(proof.success, true);
  assert.equal(proof.wrapperUuid, 'new');
  assert.equal(proof.evidence.checkpoint.lineageVerified, true);
});

test('new direct parent/logicalParent reference to source anchor can prove lineage without a copied header', async t => {
  for (const link of ['parentUuid', 'logicalParentUuid']) {
    const h = harness(t);
    h.setOwner({ sourceBaseline: { sessionId: 'session-a', filePath: h.file } });
    h.setBinding(null);
    const token = h.admit(); h.write(token);
    const child = path.join(h.scratch, link + '.jsonl');
    fs.writeFileSync(child, line({ type: 'system', uuid: 'child-start', sessionId: 'child', [link]: 'anchor-a' })
      + line(wrapper('new', { sessionId: 'child', parentUuid: 'child-start' })) + line(output('new', { sessionId: 'child' })));
    h.setBinding({ sessionId: 'child', filePath: child });
    assert.equal((await h.read(token)).success, true, link);
  }
});

test('wrong anchor hash and foreign-SID parent link do not prove lineage', async t => {
  const h = harness(t);
  h.setOwner({ sourceBaseline: { sessionId: 'session-a', filePath: h.file } }); h.setBinding(null);
  const token = h.admit(); h.write(token);
  const child = path.join(h.scratch, 'child.jsonl');
  fs.writeFileSync(child, line({ ...anchor(), message: { role: 'assistant', content: 'rewritten' } })
    + line({ uuid: 'foreign', sessionId: 'other', parentUuid: 'anchor-a' })
    + line(wrapper('unrelated', { sessionId: 'child', parentUuid: 'other-parent' })) + line(output('unrelated', { sessionId: 'child' })));
  h.setBinding({ sessionId: 'child', filePath: child });
  assert.equal((await h.read(token)).reason, 'lineage-pending');
});

test('a partial source EOF cannot license copied history after its preceding anchor', async t => {
  const h = harness(t, { initial: line(anchor()) + '{"type":"user"' });
  h.setOwner({ sourceBaseline: { sessionId: 'session-a', filePath: h.file } }); h.setBinding(null);
  const token = h.admit(); h.write(token);
  const child = path.join(h.scratch, 'child.jsonl');
  fs.writeFileSync(child, line(anchor()) + line(wrapper('ambiguous', { sessionId: 'child' })) + line(output('ambiguous', { sessionId: 'child' })));
  h.setBinding({ sessionId: 'child', filePath: child });
  assert.equal((await h.read(token)).reason, 'lineage-unknown');
});

test('resume that keeps exact source inode starts at captured EOF instead of rereading old commands', async t => {
  const h = harness(t, { initial: line(wrapper('old')) + line(output('old')) + line(anchor()) });
  h.setOwner({ sourceBaseline: { sessionId: 'session-a', filePath: h.file } }); h.setBinding(null);
  const token = h.admit(); h.write(token);
  h.setBinding({ sessionId: 'session-a', filePath: h.file });
  assert.equal((await h.read(token)).success, false);
  h.append(wrapper('new'), output('new'));
  assert.equal((await h.read(token)).wrapperUuid, 'new');
});

test('inode replacement and observed truncation remain unknown despite a matching pair', async t => {
  for (const mode of ['replace', 'truncate']) {
    const h = harness(t);
    const token = h.admit(); h.write(token);
    h.append(wrapper('current'));
    await h.read(token);
    if (mode === 'replace') {
      const replacement = path.join(h.scratch, 'replacement');
      fs.writeFileSync(replacement, line(anchor()) + line(wrapper('current')) + line(output('current')));
      fs.renameSync(replacement, h.file);
    } else fs.truncateSync(h.file, 0);
    const proof = await h.read(token);
    assert.equal(proof.success, false);
    assert.equal(proof.reason, mode === 'replace' ? 'transcript-replaced' : 'transcript-truncated');
  }
});

test('stale owner or rebind during asynchronous parser cannot publish old success', async t => {
  for (const change of ['owner', 'binding', 'file']) {
    let h;
    h = harness(t, { factory: { readOutcome: async () => {
      if (change === 'owner') h.setActive(false);
      else if (change === 'binding') h.setBinding({ sessionId: 'session-a', filePath: h.file, bindingRevision: 2 });
      else {
        const replacement = path.join(h.scratch, 'new-inode');
        fs.writeFileSync(replacement, line(anchor())); fs.renameSync(replacement, h.file);
      }
      return { success: true, reason: 'fixture-success' };
    } } });
    const token = h.admit(); h.write(token); h.append(wrapper('current'), output('current'));
    const proof = await h.read(token);
    assert.equal(proof.success, false, change);
    assert.match(proof.reason, /changed|replaced/, change);
  }
});

test('readOutcome receives only exact pair and preserves observed/requestSatisfied uncertainty', async t => {
  const received = [];
  const h = harness(t, { factory: { readOutcome: (records, command, options) => {
    received.push({ records, command, options });
    return { success: true, actualValue: null, requestSatisfied: null, observed: { label: 'Fable 5' } };
  } } });
  const token = h.admit('/model claude-fable-5[1m]'); h.write(token);
  h.append(wrapper('model', { command: 'model', value: 'claude-fable-5[1m]' }),
    output('not-model'), output('model', { text: 'Set model to Fable 5' }));
  const proof = await h.read(token);
  assert.equal(proof.success, true);
  assert.equal(proof.requestSatisfied, null);
  assert.equal(proof.actualValue, null);
  assert.deepEqual(proof.observed, { label: 'Fable 5' });
  assert.deepEqual(received[0].records.map(record => record.uuid), ['model', 'model-out']);
  assert.deepEqual(received[0].options, { sessionId: 'session-a', wrapperUuid: 'model', afterMs: 0 });
});

test('explicit paired rejection is terminal and uncertain write never authorizes another Enter', async t => {
  const h = harness(t);
  const token = h.admit();
  h.service.prepareWrite(token, 'enter'); h.service.markUncertain(token, 'enter');
  h.append(wrapper('rejected'), output('rejected', { text: 'API error: 429 rate limit' }));
  const proof = await h.read(token);
  assert.equal(proof.success, false);
  assert.equal(proof.terminal, true);
  assert.equal(proof.failureCode, 'claude_rate_limit');
  assert.equal(h.service.prepareWrite(token, 'enter').allowed, false);
});

test('same physical file uses one incremental wrapper index, not a full prefix scan per command', async t => {
  let readBytes = 0;
  const observedFs = { ...fs, promises: { ...fs.promises, open: async (...args) => {
    const handle = await fs.promises.open(...args);
    return { stat: () => handle.stat(), close: () => handle.close(), read: async (...readArgs) => {
      const result = await handle.read(...readArgs); readBytes += result.bytesRead; return result;
    } };
  } } };
  const h = harness(t, { initial: line({ type: 'noise', text: 'x'.repeat(1500000) }) + line(anchor()), factory: { fs: observedFs } });
  const first = h.admit(); h.write(first); h.append(wrapper('first'), output('first'));
  assert.equal((await h.read(first)).success, true);
  assert.ok(readBytes >= 1500000);
  readBytes = 0;
  const second = h.admit(); h.write(second); h.append(wrapper('second'), output('second'));
  assert.equal((await h.read(second)).success, true);
  assert.ok(readBytes < 64 * 1024, 'second operation reads only the appended prefix and its own tail');
  assert.equal((await h.read(first)).wrapperUuid, 'first', 'advanced shared index must not erase earlier exact proof');
});

test('physical input revisions are captured at paste and Enter without rejecting own reservation', async t => {
  const h = harness(t);
  const token = h.admit();
  h.setOwner({ inputRevision: 10 });
  assert.equal(h.service.prepareWrite(token, 'paste').allowed, true);
  h.service.markWritten(token, 'paste');
  h.setOwner({ inputRevision: 12 });
  assert.equal(h.service.prepareWrite(token, 'paste').evidence.write.pasteInputRevision, 10, 'later chunks keep first-byte identity');
  h.setOwner({ inputRevision: 11 });
  const entering = h.service.prepareWrite(token, 'enter');
  assert.equal(entering.allowed, true);
  assert.equal(entering.evidence.owner.inputRevision, 9);
  assert.equal(entering.evidence.write.admissionInputRevision, 9);
  assert.equal(entering.evidence.write.pasteInputRevision, 10);
  assert.equal(entering.evidence.write.enterInputRevision, 11);
});

test('checkpoint I/O failure on an existing fresh file is not permission to start from zero', async t => {
  let deny = true;
  const faultyFs = { ...fs, openSync: (...args) => {
    if (deny) throw Object.assign(new Error('fixture unreadable'), { code: 'EACCES' });
    return fs.openSync(...args);
  } };
  const h = harness(t, { initial: line(wrapper('old')) + line(output('old')), owner: { freshLaunch: true }, factory: { fs: faultyFs } });
  const token = h.admit(); h.write(token);
  deny = false;
  const proof = await h.read(token);
  assert.equal(proof.success, false);
  assert.equal(proof.reason, 'enter-checkpoint-unavailable');
});

test('concurrent operations share the initial prefix I/O as well as its small UUID index', async t => {
  let readBytes = 0;
  const observedFs = { ...fs, promises: { ...fs.promises, open: async (...args) => {
    const handle = await fs.promises.open(...args);
    return { stat: () => handle.stat(), close: () => handle.close(), read: async (...readArgs) => {
      const result = await handle.read(...readArgs); readBytes += result.bytesRead; return result;
    } };
  } } };
  const initial = line({ type: 'noise', text: 'x'.repeat(1500000) }) + line(anchor());
  const h = harness(t, { initial, factory: { fs: observedFs, readOutcome: () => ({ success: true }) } });
  const a = h.admit(); h.write(a);
  const b = h.admit('/model sonnet'); h.write(b);
  h.append(wrapper('effort'), output('effort'), wrapper('model', { command: 'model', value: 'sonnet' }),
    output('model', { text: 'Set model to Sonnet 5' }));
  const proofs = await Promise.all([h.read(a), h.read(b)]);
  assert.equal(proofs.every(proof => proof.success), true);
  assert.ok(readBytes < Buffer.byteLength(initial) + 32 * 1024, 'no duplicate full historical scan');
});

test('owner change while a file read awaits cannot publish a buffered pair', async t => {
  let h;
  let changed = false;
  const observedFs = { ...fs, promises: { ...fs.promises, open: async (...args) => {
    const handle = await fs.promises.open(...args);
    return { stat: () => handle.stat(), close: () => handle.close(), read: async (...readArgs) => {
      const result = await handle.read(...readArgs);
      if (!changed) { changed = true; h.setActive(false); }
      return result;
    } };
  } } };
  h = harness(t, { factory: { fs: observedFs } });
  const token = h.admit(); h.write(token); h.append(wrapper('current'), output('current'));
  const proof = await h.read(token);
  assert.equal(proof.success, false);
  assert.equal(proof.reason, 'owner-or-binding-changed');
});

test('same-inode truncate/regrow and mutation of an already bound record cannot reuse old success', async t => {
  for (const mode of ['prefix', 'command']) {
    const h = harness(t);
    const token = h.admit(); h.write(token); h.append(wrapper('current'), output('current'));
    assert.equal((await h.read(token)).success, true);
    const originalInode = fs.statSync(h.file).ino;
    if (mode === 'prefix') fs.writeFileSync(h.file, line({ ...anchor(), changed: true }) + line(wrapper('current')) + line(output('current')));
    else fs.writeFileSync(h.file, line(anchor()) + line(wrapper('current', { value: 'low' })) + line(output('current')));
    assert.equal(fs.statSync(h.file).ino, originalInode);
    const proof = await h.read(token);
    assert.equal(proof.success, false);
    assert.equal(proof.reason, mode === 'prefix' ? 'transcript-rewritten' : 'command-record-changed');
  }
});

test('a new explicit operation can build a new index after a historical rewrite without reviving old proof', async t => {
  const h = harness(t);
  const old = h.admit(); h.write(old); h.append(wrapper('old'), output('old'));
  assert.equal((await h.read(old)).success, true);
  fs.writeFileSync(h.file, line(anchor('new-anchor')));
  h.setOwner({ lifecycleGeneration: 'generation-b' });
  const fresh = h.admit(); h.write(fresh); h.append(wrapper('new'), output('new'));
  assert.equal((await h.read(fresh)).success, true);
  assert.equal((await h.read(old)).reason, 'owner-changed');
});

test('asynchronous file close is guarded before positive proof leaves the reader', async t => {
  let h;
  const observedFs = { ...fs, promises: { ...fs.promises, open: async (...args) => {
    const handle = await fs.promises.open(...args);
    return { stat: () => handle.stat(), read: (...readArgs) => handle.read(...readArgs), close: async () => {
      await handle.close(); h.setActive(false);
    } };
  } } };
  h = harness(t, { factory: { fs: observedFs } });
  const token = h.admit(); h.write(token); h.append(wrapper('current'), output('current'));
  const proof = await h.read(token);
  assert.equal(proof.success, false);
  assert.equal(proof.reason, 'owner-or-binding-changed');
});

test('equal-size in-place command rewrite during asynchronous close cannot publish stale proof', async t => {
  let h;
  let rewritten = false;
  const observedFs = { ...fs, promises: { ...fs.promises, open: async (...args) => {
    const handle = await fs.promises.open(...args);
    return { stat: () => handle.stat(), read: (...readArgs) => handle.read(...readArgs), close: async () => {
      await handle.close();
      if (!rewritten) {
        rewritten = true;
        const before = fs.readFileSync(h.file, 'utf8');
        const after = before.replaceAll('max', 'low');
        assert.equal(Buffer.byteLength(after), Buffer.byteLength(before));
        fs.writeFileSync(h.file, after);
      }
    } };
  } } };
  h = harness(t, { factory: { fs: observedFs } });
  const token = h.admit(); h.write(token); h.append(wrapper('current'), output('current'));
  const inode = fs.statSync(h.file).ino;
  const proof = await h.read(token);
  assert.equal(fs.statSync(h.file).ino, inode);
  assert.equal(proof.success, false);
  assert.equal(proof.reason, 'command-record-changed');
});

test('failed Enter checkpoint cannot accept an older pair that arrived during paste preparation', async t => {
  let deny = false;
  const faultyFs = { ...fs, openSync: (...args) => {
    if (deny) throw Object.assign(new Error('fixture unreadable'), { code: 'EACCES' });
    return fs.openSync(...args);
  } };
  const h = harness(t, { factory: { fs: faultyFs } });
  const token = h.admit(); h.service.prepareWrite(token, 'paste'); h.service.markWritten(token, 'paste');
  h.append(wrapper('pre-enter'), output('pre-enter'));
  deny = true;
  assert.equal(h.service.prepareWrite(token, 'enter').allowed, true, 'the evidence store does not disable the executor');
  h.service.markWritten(token, 'enter');
  deny = false;
  const proof = await h.read(token);
  assert.equal(proof.success, false);
  assert.equal(proof.reason, 'enter-checkpoint-unavailable');
  assert.equal(h.service.prepareWrite(token, 'enter').allowed, false);
});
