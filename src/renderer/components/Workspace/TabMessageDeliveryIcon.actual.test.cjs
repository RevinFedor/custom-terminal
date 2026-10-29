'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const ts = require('typescript');
const { Check, ChevronRight, CircleAlert, CircleCheck, LoaderCircle, SendHorizontal, MessageSquareReply, Timer, X } = require('lucide-react');

// Source/SSR control only: no browser, native geometry, pixels or CPU attribution.
function declarations(file, names) {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return names.map(name => {
    const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(node, `actual function ${name}`);
    return node.getText(ast).replace(/^export /, '');
  }).join('\n');
}
function compile(source, names, bindings = {}) {
  const output = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  }, fileName: 'actual-delivery-icon.tsx' }).outputText;
  return new Function(...Object.keys(bindings), output + '\nreturn {' + names.join(',') + '};')(...Object.values(bindings));
}
const oldDeliveryIcon = `function DeliveryIcon({ presentation, header = false }) {
  const Icon = presentation.icon === 'error' ? CircleAlert : presentation.icon === 'delivered' ? header ? CircleCheck : Check : presentation.icon === 'sending' ? LoaderCircle : Timer;
  return <Icon size={header ? 14 : 11} strokeWidth={header ? 2.2 : 2} style={{ flexShrink: 0, color: presentation.color }} className={presentation.spinning ? 'animate-spin noted-infinite-animation' : undefined} />;
}`;
const file = path.join(__dirname, 'TabMessageTracker.tsx');
const actualDeliveryIcon = declarations(file, ['DeliveryIcon']);
const projectionNames = ['tabMessageDelivery', 'tabMessageReplyPresentation', 'tabMessageReplyDelivery', 'tabMessagePresentation', 'tabMessagePeer', 'tabMessageDismissed'];
const projection = compile(declarations(path.join(__dirname, '../../utils/tabMessageProjection.ts'), projectionNames), projectionNames);
const rowExports = {};
new Function('React', 'exports', ts.transpileModule(fs.readFileSync(path.join(__dirname, 'RequestTrackerRow.tsx'), 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS },
}).outputText)(React, rowExports);
const bodyAndRow = declarations(file, ['TabMessageRow', 'MessageBody']);
const bindings = { React, Check, ChevronRight, CircleAlert, CircleCheck, LoaderCircle, SendHorizontal, MessageSquareReply, Timer, X,
  ...rowExports, ...projection,
  // Unchanged external surfaces are inert SSR stand-ins, never application API calls.
  TabMessageSourceChip: ({ source, leadingIcon }) => React.createElement('span', { 'data-source': source.sourceTabId }, leadingIcon, source.sourceTabName),
  HistoryPromptSource: () => React.createElement('span', null, 'source'),
  AttachmentPreviewToolbar: () => null,
  Markdown: ({ text }) => React.createElement('div', null, text),
  exactText: {},
};
const names = ['DeliveryIcon', 'TabMessageRow', 'MessageBody'];
const old = compile(oldDeliveryIcon + '\n' + bodyAndRow, names, bindings);
const current = compile(actualDeliveryIcon + '\n' + bodyAndRow, names, bindings);
const markup = element => renderToStaticMarkup(element);
const iconMarkup = (implementation, presentation, header) => markup(React.createElement(implementation.DeliveryIcon, { presentation, header }));
const base = { messageId: 'Q', kind: 'question', sourceTabId: 'A', sourceTabName: 'Sender', targetTabId: 'B', targetTabName: 'Receiver',
  createdAt: 10, updatedAt: 20, deliveryState: 'sent', text: 'Saved question' };

test('OLD/CURRENT complete Lucide SVG output and properties survive both sizes and every icon/spin branch', () => {
  for (const icon of ['sending', 'delivered', 'error', 'waiting']) {
    for (const spinning of [true, false]) {
      for (const header of [undefined, false, true]) {
        const presentation = { icon, spinning, color: '#60a5fa', label: 'Delivery label' };
        const props = { presentation, header }, size = header ? 14 : 11;
        const before = old.DeliveryIcon(props), after = current.DeliveryIcon(props);
        const svg = spinning ? after.props.children : after;
        assert.equal(svg.type, before.type, `${icon}/${header}: exact Lucide component`);
        assert.equal(svg.props.size, size);
        assert.equal(svg.props.strokeWidth, header ? 2.2 : 2);
        const { className, ...beforeProps } = before.props;
        const expectedProps = { ...beforeProps, style: { ...before.props.style, display: spinning ? 'block' : undefined } };
        assert.deepEqual(svg.props, expectedProps, 'only remove animation ownership and blockify the nested SVG');
        const expectedSvg = React.cloneElement(before, { className: undefined, style: expectedProps.style });
        assert.equal(markup(svg), markup(expectedSvg), 'compare the entire SVG, including every path/attribute/aria property');
        assert.match(markup(svg), /aria-hidden="true"/);
        assert.doesNotMatch(markup(svg), /animate-spin|noted-infinite-animation|transform/);
        if (spinning) {
          assert.equal(after.type, 'span', 'the only animation owner is HTML');
          assert.equal(after.props.className, 'animate-spin noted-infinite-animation');
          assert.deepEqual(after.props.style, { display: 'block', width: size, height: size, flexShrink: 0, willChange: 'transform' });
          assert.equal(after.props.role, undefined);
          assert.equal(after.props.tabIndex, undefined);
          assert.equal(React.Children.count(after.props.children), 1);
        } else {
          assert.equal(markup(after), markup(before), 'static markup stays byte-identical, without an added carrier');
        }
        const slotProps = { title: presentation.label, 'data-tab-message-status-icon': icon };
        const slotBefore = rowExports.RequestTrackerStatus({ ...slotProps, children: before });
        const slotAfter = rowExports.RequestTrackerStatus({ ...slotProps, children: after });
        assert.deepEqual({ ...slotAfter.props, children: null }, { ...slotBefore.props, children: null });
        assert.equal(slotAfter.props.style.width, 26);
        assert.equal(slotAfter.props.style.height, 14);
        assert.equal(slotAfter.props.style.justifyContent, 'center');
        assert.equal(slotAfter.props.style.flexShrink, 0);
      }
    }
  }
});

test('the same spin utility, centered square and exact hidden-owner pause targets govern the HTML carrier', () => {
  const theme = fs.readFileSync(require.resolve('tailwindcss/theme.css'), 'utf8');
  assert.match(theme, /--animate-spin:\s*spin 1s linear infinite;/, 'keep period, easing, direction and infinite feedback');
  const styles = path.join(__dirname, '../../styles');
  const globals = fs.readFileSync(path.join(styles, 'globals.css'), 'utf8');
  assert.match(globals, /@keyframes spin\s*\{\s*from\s*\{\s*transform:\s*rotate\(0deg\);\s*\}\s*to\s*\{\s*transform:\s*rotate\(360deg\);\s*\}\s*\}/);
  const css = fs.readFileSync(path.join(styles, 'presentationAnimations.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const pauseRule = css.slice(0, css.indexOf('}') + 1);
  for (const owner of ['[data-terminal-pane-wrapper][data-terminal-surface-presented="0"]', '[data-terminal-pane-chrome-host][aria-hidden="true"]',
    '[data-single-center-focus-boundary][aria-hidden="true"]', '[data-history-owner][data-history-presented="0"]',
    '[data-tab-sidebar-layer][data-sidebar-presented="0"]', '[data-workspace-presentation][aria-hidden="true"]']) assert.ok(pauseRule.includes(owner));
  assert.match(pauseRule, /\.noted-infinite-animation\s*,\s*\.animate-spin\s*,/);
  assert.match(pauseRule, /animation-play-state:\s*paused !important/);
  assert.doesNotMatch(pauseRule, /:focus(?:-within|-visible)?\b|svg\b|\[(?:class|style)[*^$|~]?=/, 'visible unfocused feedback keeps the same exact-class gate');
  for (const header of [false, true]) {
    const element = current.DeliveryIcon({ presentation: { icon: 'sending', color: '#60a5fa', spinning: true }, header });
    assert.equal(element.props.style.width, element.props.children.props.size);
    assert.equal(element.props.style.height, element.props.children.props.size);
    assert.equal(element.props.style.transformOrigin, undefined, 'keep the default centered HTML transform origin');
    assert.equal(element.props.children.props.style.transformOrigin, undefined);
  }
});

function findElement(element, predicate) {
  if (!React.isValidElement(element)) return undefined;
  if (predicate(element)) return element;
  for (const child of React.Children.toArray([element.props.children, element.props.actions])) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
}
test('actual rows preserve status slots, title/aria/actions, Send/Reply, cancellation identity and wait/error variants', () => {
  const variants = ['pending', 'sending', 'queued', 'waiting-for-input', 'unconfirmed', 'failed', 'sent'].map(deliveryState => ({ question: { ...base, deliveryState } }));
  variants.push({ question: { ...base, deliveryState: 'sending', cancelledAt: 30 } },
    { question: { ...base, loopWait: { revision: 1, state: 'returning', disposition: 'reply_timeout', notice: { state: 'queued' } } } },
    { question: { ...base, replyMessageId: 'R', loopWait: { revision: 2, state: 'returning', replyDeliveryState: 'sent', disposition: 'reply_processing_timeout', notice: { state: 'sent' } } } });
  for (const deliveryState of ['sending', 'sent', 'failed']) variants.push({ question: { ...base, replyMessageId: 'R' },
    reply: { ...base, messageId: 'R', kind: 'reply', replyTo: 'Q', sourceTabId: 'B', targetTabId: 'A', deliveryState } });
  for (const variant of variants) for (const incoming of [false, true]) for (const history of [false, true]) {
    const thread = { ...variant, incoming, answerAvailable: Boolean(variant.reply || variant.question.replyMessageId) };
    const calls = [], anchor = { getBoundingClientRect: () => rect }, rect = { top: 1, left: 2, width: 100, height: 48 };
    const props = { thread, tabId: incoming ? 'B' : 'A', history, selected: true, error: 'Saved cancellation error',
      onOpen: selection => calls.push(selection), onDismiss: id => calls.push(id) };
    const before = old.TabMessageRow(props), after = current.TabMessageRow(props);
    const presentation = projection.tabMessagePresentation(thread);
    const beforeHtml = markup(before), afterHtml = markup(after);
    const hasStatus = history || presentation.icon !== 'sending';
    assert.equal(hasStatus ? afterHtml.replace(iconMarkup(current, presentation, true), iconMarkup(old, presentation, true)) : afterHtml, beforeHtml,
      'complete actual row differs only at the HTML animation carrier');
    assert.match(afterHtml, /data-tab-question-delivery=/);
    assert.match(afterHtml, /data-tab-reply-delivery=/);
    assert.match(afterHtml, />Send</); assert.match(afterHtml, />Reply</);
    assert.match(afterHtml, /aria-expanded="true"/);
    for (const element of [before, after]) {
      findElement(element, node => node.props['data-tab-message-open'] === 'Q').props.onClick({ currentTarget: { closest: selector => {
        assert.equal(selector, '[data-tab-message-row]'); return anchor;
      } } });
      const dismiss = findElement(element, node => node.props['data-tab-message-dismiss'] === 'Q');
      if (variant.question.cancelledAt) assert.equal(dismiss, undefined);
      else { assert.equal(dismiss.props['aria-label'], 'Скрыть переписку'); dismiss.props.onClick(); }
    }
    const expectedCalls = [{ messageId: 'Q', anchor, rect }, ...(variant.question.cancelledAt ? [] : ['Q'])];
    assert.deepEqual(calls, [...expectedCalls, ...expectedCalls]);
  }
});

test('actual message-body 11px delivery, disclosure, text and metadata preserve every delivery state', () => {
  for (const deliveryState of ['pending', 'sending', 'queued', 'waiting-for-input', 'unconfirmed', 'failed', 'sent']) {
    const message = { ...base, deliveryState, code: 'SAVED_CODE', error: 'Saved delivery error' };
    const props = { message, label: 'Вопрос', onNavigate() {} }, presentation = projection.tabMessageDelivery(message);
    const before = markup(old.MessageBody(props)), after = markup(current.MessageBody(props));
    assert.equal(after.replace(iconMarkup(current, presentation, false), iconMarkup(old, presentation, false)), before);
    assert.match(after, /data-tab-message-body="Q"/);
    assert.match(after, /data-tab-message-text="Q"/);
    assert.match(after, /Saved question/);
    assert.match(after, /SAVED_CODE: Saved delivery error/);
  }
});
