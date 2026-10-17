import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const renderer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(path.join(renderer, 'main.tsx'), 'utf8');

test('renderer entry owns one window-scoped bootstrap lease across Vite re-evaluation', () => {
  assert.match(main, /__notedTerminalRendererBootstrapStarted\?: boolean/);
  assert.match(main, /if \(!rendererBootstrapWindow\.__notedTerminalRendererBootstrapStarted\) \{/);
  assert.match(main, /rendererBootstrapWindow\.__notedTerminalRendererBootstrapStarted = true/);
  assert.match(main, /rendererBootstrapWindow\.__notedTerminalRendererBootstrapStarted = false/);
  assert.equal((main.match(/ReactDOM\.createRoot\(/g) || []).length, 1);
});

function forwardedBootstrapFailure(error) {
  const marker = '}).catch((error) => {';
  const start = main.lastIndexOf(marker);
  assert.notEqual(start, -1);
  const end = main.indexOf('\n  });', start);
  assert.notEqual(end, -1);
  const runtime = { __notedTerminalRendererBootstrapStarted: true };
  const messages = [];
  const fail = vm.runInNewContext('(error) => {' + main.slice(start + marker.length, end) + '}', {
    rendererBootstrapWindow: runtime,
    console: {
      error: (...args) => messages.push(args.map(value =>
        typeof value === 'string' ? value : JSON.stringify(value)).join(' ')),
    },
  });
  fail(error);
  assert.equal(runtime.__notedTerminalRendererBootstrapStarted, false);
  assert.equal(messages.length, 1);
  const prefix = '[RendererBootstrap] failed to load application modules ';
  assert.ok(messages[0].startsWith(prefix));
  return JSON.parse(messages[0].slice(prefix.length));
}

test('bootstrap import Error survives the actual catch and JSON file forwarding', () => {
  const error = new SyntaxError('The requested module does not provide an export named resolveWorkingDirectory');
  const forwarded = forwardedBootstrapFailure(error);
  assert.equal(forwarded.name, error.name);
  assert.equal(forwarded.message, error.message);
  assert.equal(forwarded.stack, error.stack);
});

test('bootstrap diagnostics stay bounded and retain non-Error rejection values', () => {
  const error = new Error('x'.repeat(1500));
  error.name = 'n'.repeat(150);
  error.stack = 's'.repeat(5000);
  const forwarded = forwardedBootstrapFailure(error);
  assert.equal(forwarded.name.length, 100);
  assert.equal(forwarded.message.length, 1000);
  assert.equal(forwarded.stack.length, 4000);
  assert.deepEqual(forwardedBootstrapFailure('import rejected'), {
    name: 'string', message: 'import rejected', stack: '',
  });
});
