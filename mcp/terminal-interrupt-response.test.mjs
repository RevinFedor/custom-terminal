import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./terminal-server.mjs', import.meta.url), 'utf8');
const start = source.indexOf("    case 'interrupt_ai': {");
const end = source.indexOf("    case 'read_draft': {", start);
assert.ok(start > 0 && end > start);
const handler = source.slice(start, end);

async function response(receipt) {
  const context = vm.createContext({
    projectHint: () => ({ projectId: 'P' }),
    httpApiPost: async (_target, path) => {
      assert.equal(path, '/api/terminal-tabs/T/interrupt');
      return receipt;
    },
  });
  vm.runInContext('async function invoke(args) { switch ("interrupt_ai") { ' + handler + ' } }', context);
  return context.invoke({ tabId: 'T' });
}

test('MCP delivered Claude request is not mislabeled as idle or completed interruption', async () => {
  const text = await response({ success: true, interrupted: false, interruptRequested: true });
  assert.match(text, /request delivered/);
  assert.match(text, /not yet confirmed/);
  assert.doesNotMatch(text, /no active turn/);
});

test('MCP idle and changed-turn skip preserve the actual no-op reason', async () => {
  for (const reason of ['turn-already-idle', 'target-turn-finished']) {
    const text = await response({ success: true, interrupted: false, interruptRequested: false, reason });
    assert.match(text, /no active turn was interrupted/);
    assert.ok(text.includes(reason));
  }
});

test('MCP explicit provider confirmation remains stronger than request delivery', async () => {
  const text = await response({ success: true, interrupted: true,
    interruptRequested: true, interruptConfirmed: true });
  assert.match(text, /interruption confirmed/);
  assert.doesNotMatch(text, /not yet confirmed/);
});
