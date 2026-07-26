const test = require('node:test');
const assert = require('node:assert/strict');
const {
  HistoryPayloadStash,
  dehydrateHistoryEntries,
  capPayloadForRender,
  HISTORY_PAYLOAD_RENDER_CAP,
} = require('./history-payload-dehydrate');

const bigText = (fill, chars) => fill.repeat(Math.ceil(chars / fill.length)).slice(0, chars);

test('dehydrates a heavy raw tool result into preview + ref and stashes the original', () => {
  const stash = new HistoryPayloadStash();
  const original = bigText('output line\n', 40 * 1024);
  const entries = [{
    uuid: 'a-1',
    role: 'assistant',
    actions: [{
      tool: '__raw__',
      rawTool: { toolUseId: 'toolu_01', toolName: 'Bash', args: {}, result: original },
    }],
  }];
  const summary = dehydrateHistoryEntries({
    toolType: 'claude', sessionId: 's1', entries, stash,
  });
  assert.equal(summary.dehydrated, 1);
  const rawTool = entries[0].actions[0].rawTool;
  assert.ok(rawTool.result.length < original.length);
  assert.ok(rawTool.result.includes('полный вывод загрузится'));
  assert.deepEqual(rawTool.resultRef, { payloadId: 'result:toolu_01', totalChars: original.length });
  assert.equal(stash.get('claude', 's1', 'result:toolu_01'), original);
});

test('small payloads stay inline without refs', () => {
  const entries = [{
    uuid: 'a-1',
    role: 'assistant',
    thinking: 'short thought',
    actions: [{
      tool: '__raw__',
      rawTool: { toolUseId: 't1', toolName: 'Bash', args: {}, result: 'ok' },
    }],
  }];
  const summary = dehydrateHistoryEntries({ toolType: 'claude', sessionId: 's1', entries });
  assert.equal(summary.dehydrated, 0);
  assert.equal(entries[0].actions[0].rawTool.result, 'ok');
  assert.equal(entries[0].actions[0].rawTool.resultRef, undefined);
  assert.equal(entries[0].thinkingRef, undefined);
});

test('thinking and compact use entry-uuid identities; compact opt-out respected', () => {
  const stash = new HistoryPayloadStash();
  const heavy = bigText('think ', 30 * 1024);
  const entries = [
    { uuid: 'u-think', role: 'assistant', thinking: heavy },
    { uuid: 'u-compact', role: 'compact', compactSummary: heavy },
  ];
  dehydrateHistoryEntries({
    toolType: 'codex', sessionId: 's2', entries, stash, dehydrateCompact: false,
  });
  assert.ok(entries[0].thinkingRef);
  assert.equal(entries[0].thinkingRef.payloadId, 'thinking:u-think');
  assert.equal(entries[1].compactSummaryRef, undefined);
  assert.equal(entries[1].compactSummary, heavy);
  dehydrateHistoryEntries({ toolType: 'codex', sessionId: 's2', entries, stash });
  assert.ok(entries[1].compactSummaryRef);
  assert.equal(stash.get('codex', 's2', 'compact:u-compact'), heavy);
});

test('missing toolUseId falls back to entry uuid + action index', () => {
  const entries = [{
    uuid: 'entry-9',
    role: 'assistant',
    actions: [{
      tool: '__raw__',
      rawTool: { toolName: 'Bash', args: {}, result: bigText('x', 20 * 1024) },
    }],
  }];
  dehydrateHistoryEntries({ toolType: 'claude', sessionId: 's1', entries });
  assert.equal(entries[0].actions[0].rawTool.resultRef.payloadId, 'result:entry-9:0');
});

test('stash evicts least-recent under byte pressure', () => {
  // JS strings are 2 bytes/char in the stash accounting: 12K chars ≈ 24KB.
  // Two entries fit the 64KB budget, three do not.
  const stash = new HistoryPayloadStash(64 * 1024);
  stash.set('claude', 's', 'a', bigText('a', 12 * 1024));
  stash.set('claude', 's', 'b', bigText('b', 12 * 1024));
  assert.ok(stash.get('claude', 's', 'a'));
  stash.set('claude', 's', 'c', bigText('c', 12 * 1024));
  assert.equal(stash.get('claude', 's', 'b'), null);
  assert.ok(stash.get('claude', 's', 'a'));
  assert.ok(stash.get('claude', 's', 'c'));
});

test('capPayloadForRender caps oversized payload and reports totals', () => {
  const capped = capPayloadForRender(bigText('y', HISTORY_PAYLOAD_RENDER_CAP + 100));
  assert.equal(capped.truncatedForRender, true);
  assert.equal(capped.payload.length, HISTORY_PAYLOAD_RENDER_CAP);
  assert.equal(capped.totalChars, HISTORY_PAYLOAD_RENDER_CAP + 100);
  const small = capPayloadForRender('abc');
  assert.equal(small.truncatedForRender, false);
  assert.equal(small.payload, 'abc');
});
