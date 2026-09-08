import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererTerminal = fs.readFileSync(path.join(here, 'Terminal.tsx'), 'utf8');
const main = fs.readFileSync(path.join(here, '..', '..', '..', 'main', 'main.js'), 'utf8');

test('renderer normal and lazy xterm share one 5k scrollback budget', () => {
  assert.match(rendererTerminal, /const RENDERER_XTERM_SCROLLBACK = 5000/);
  assert.equal(
    (rendererTerminal.match(/scrollback: RENDERER_XTERM_SCROLLBACK/g) || []).length,
    2,
  );
  assert.doesNotMatch(rendererTerminal, /scrollback: (?:10000|50000)/);
});

test('main headless mirror uses the same bounded raw tail', () => {
  assert.match(main, /const HEADLESS_XTERM_SCROLLBACK = 5000/);
  assert.match(main, /scrollback: HEADLESS_XTERM_SCROLLBACK/);
});
