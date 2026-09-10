import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import { showAgentDraftScreenContradictionToast } from './agentDraftContradictionToast.mjs';
const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const source = fs.readFileSync(new URL('../components/UI/Toast.tsx', import.meta.url), 'utf8');
const card = source.slice(source.indexOf('function ToastCard('));
const compiled = transformSync(card, { loader: 'tsx', format: 'cjs' }).code;
const makeCard = (react, clipboard) => new Function('React', 'ChevronDown', 'ChevronRight', 'Github',
  'window', 'setTimeout', 'clearTimeout', compiled + '\nreturn ToastCard;')(
  react, () => null, () => null, () => null,
  { require: name => { assert.equal(name, 'electron'); return { clipboard }; } },
  () => 1, () => {},
);

test('actual ToastCard renders Copy for the recovered-input report and its click copies the exact report', () => {
  let toast;
  showAgentDraftScreenContradictionToast({ showToast(...args) {
    toast = { id: 'incident', message: args[0], type: args[1], persistent: args[3],
      copyText: args[4], tabId: args[7], details: args[9] };
  } }, { tabId: 'T', label: 'Codex', exactCapture: { captureRequestId: 'C', proofOutcome: 'absent' } });
  const props = { toast, expanded: true, animatedToastIdsRef: { current: new Set() },
    removeToast() { assert.fail('copy must not dismiss the notice'); },
    toggleToastDetails() { assert.fail('copy must not toggle details'); } };
  const copied = [];
  const clipboard = { writeText: text => copied.push(text) };
  const Card = makeCard(React, clipboard);
  const html = renderToStaticMarkup(React.createElement(Card, props));
  assert.match(html, />copy<\/span>/);
  assert.match(html, /data-toast-type="warning"/);
  assert.match(html, /не ошибка доставки/);
  const hookless = { ...React, useState: value => [value, () => {}], useRef: value => ({ current: value }), useEffect() {} };
  const tree = makeCard(hookless, clipboard)(props);
  const findCopy = node => {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'span' && node.props?.children === 'copy') return node;
    return React.Children.toArray(node.props?.children).map(findCopy).find(Boolean);
  };
  const copy = findCopy(tree);
  assert.ok(copy);
  let stopped = false;
  copy.props.onClick({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.deepEqual(copied, [toast.copyText]);
  assert.match(copied[0], /Capture request ID: C/);
});
