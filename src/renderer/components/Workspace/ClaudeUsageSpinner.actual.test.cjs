'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const ts = require('typescript');
const { RefreshCw, Loader2, ChevronRight, LogOut, LogIn, X, Plus } = require('lucide-react');

// Exact loading expressions captured from the Source preimage SHA256
// 516d782a9539dad32321a6a453d7b4ce33bfedb2faf69219c4c617d51e3a728e.
// This is an SSR/actual-function control, never native geometry/pixels/performance.
const oldSites = [
  {
    "line": 767,
    "owner": "UsageSourceRefreshRow",
    "source": "<RefreshCw size={11} className=\"noted-infinite-animation\" style={{\n            animation: loading ? 'spin 1s linear infinite' : 'none',\n          }} />"
  },
  {
    "line": 1472,
    "owner": "ClaudeUsageChip",
    "source": "<RefreshCw size={12} color=\"#777\" className=\"noted-infinite-animation\" style={{ animation: 'spin 1s linear infinite' }} />"
  },
  {
    "line": 1493,
    "owner": "ClaudeUsageChip",
    "source": "<RefreshCw size={12} color=\"#DA7756\" className=\"noted-infinite-animation\" style={{ animation: 'spin 1s linear infinite' }} />"
  },
  {
    "line": 1808,
    "owner": "CodexDeviceLoginSection",
    "source": "<Loader2 size={13} className=\"noted-infinite-animation\" style={{ animation: 'spin 1s linear infinite' }} />"
  },
  {
    "line": 2368,
    "owner": "CodexUsageChip",
    "source": "<Loader2 size={12} className=\"noted-infinite-animation\" style={{ animation: 'spin 1s linear infinite' }} />"
  },
  {
    "line": 2394,
    "owner": "CodexUsageChip",
    "source": "<Loader2 size={12} className=\"noted-infinite-animation\" style={{ animation: 'spin 1s linear infinite' }} />"
  },
  {
    "line": 2421,
    "owner": "CodexUsageChip",
    "source": "<Loader2 size={12} className=\"noted-infinite-animation\" style={{ animation: 'spin 1s linear infinite' }} />"
  },
  {
    "line": 2502,
    "owner": "CodexUsageChip",
    "source": "<RefreshCw size={12} color=\"#777\" className=\"noted-infinite-animation\" style={{ animation: 'spin 1s linear infinite' }} />"
  },
  {
    "line": 2518,
    "owner": "CodexUsageChip",
    "source": "<RefreshCw size={12} color={chipColor} className=\"noted-infinite-animation\" style={{ animation: 'spin 1s linear infinite' }} />"
  },
  {
    "line": 2571,
    "owner": "CodexUsageChip",
    "source": "<Loader2 size={12} className=\"noted-infinite-animation\" style={{ animation: 'spin 1s linear infinite' }} />"
  },
  {
    "line": 2708,
    "owner": "SharedActivitySection",
    "source": "<RefreshCw size={10} className=\"noted-infinite-animation\" style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />"
  }
];
const file = path.join(__dirname, 'ClaudeUsageButton.tsx'), source = fs.readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function functionNode(name) {
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, 'actual function ' + name);
  return node;
}
function transpile(text) {
  return ts.transpileModule(text, { compilerOptions: {
    jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  }, fileName: 'actual-usage-spinner.tsx' }).outputText;
}
const icons = { React, RefreshCw, Loader2, ChevronRight, LogOut, LogIn, X, Plus };
function evaluate(text, scope = {}) {
  const bindings = { ...icons, ...scope };
  return new Function(...Object.keys(bindings), transpile('const result = (' + text + ');') + '\nreturn result;')(...Object.values(bindings));
}
const UsageSpinner = evaluate(functionNode('UsageSpinner').getText(ast));
const sites = [];
function visit(node, owner) {
  if (ts.isFunctionDeclaration(node)) owner = node.name?.text;
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'UsageSpinner') sites.push({ node, owner, expression: node.getText(ast) });
  if (owner === 'UsageSourceRefreshRow' && ts.isJsxExpression(node) && node.expression && ts.isConditionalExpression(node.expression)
    && ts.isJsxElement(node.expression.whenTrue) && node.expression.whenTrue.openingElement.tagName.getText(ast) === 'span'
    && node.expression.whenTrue.openingElement.getText(ast).includes('noted-infinite-animation')) {
    sites.push({ node, owner, expression: node.expression.getText(ast) });
    return;
  }
  ts.forEachChild(node, child => visit(child, owner));
}
visit(ast);
sites.sort((a, b) => a.node.getStart(ast) - b.node.getStart(ast));
assert.equal(sites.length, oldSites.length, 'cover all eleven preimage loading sites');
assert.deepEqual(sites.map(site => site.owner), oldSites.map(site => site.owner));
for (let i = 0; i < sites.length; i++) sites[i].old = oldSites[i].source;
function originalFrame(node) {
  let frame = node.getText(ast);
  for (const site of sites.filter(site => site.node.getStart(ast) >= node.getStart(ast) && site.node.end <= node.end).reverse()) {
    const start = site.node.getStart(ast) - node.getStart(ast), end = site.node.end - node.getStart(ast);
    frame = frame.slice(0, start) + site.old + frame.slice(end);
  }
  return frame;
}
function subject(name, original = false, scope = {}) {
  const node = functionNode(name);
  return evaluate(original ? originalFrame(node) : node.getText(ast), { UsageSpinner, ...scope });
}
function expressionRunner(expression) {
  return evaluate('function(loading, chipColor) { return (' + expression + '); }', { UsageSpinner });
}
const render = element => renderToStaticMarkup(element);
const resolve = element => element.type === UsageSpinner ? UsageSpinner(element.props) : element;
function compareIcon(before, after) {
  before = resolve(before); after = resolve(after);
  const spinning = before.props.style.animation !== 'none';
  if (!spinning) {
    assert.equal(render(after), render(before), 'nonloading SVG markup stays byte-identical');
    return;
  }
  assert.equal(after.type, 'span', 'HTML is the only rotating element');
  const svg = after.props.children;
  assert.equal(svg.type, before.type, 'same real Lucide component');
  const { className, style, ...originalProps } = before.props;
  assert.equal(after.props.className, className, 'the same pause marker moves to the animation owner');
  assert.deepEqual(after.props.style, { display: 'block', width: before.props.size, height: before.props.size,
    animation: style.animation, willChange: 'transform' });
  assert.equal(after.props.role, undefined); assert.equal(after.props.tabIndex, undefined);
  assert.deepEqual(svg.props, { ...originalProps, style: { display: 'block' } }, 'preserve every SVG prop except the animation');
  const expected = React.cloneElement(before, { className: undefined, style: { display: 'block' } });
  assert.equal(render(svg), render(expected), 'full SVG comparison includes color/stroke/size/ARIA and every path');
  assert.match(render(svg), /aria-hidden="true"/);
  assert.match(render(svg), /stroke-width="2"/);
  assert.doesNotMatch(render(svg), /noted-infinite-animation|animation:|transform:/);
}
test('all preimage RefreshCw/Loader2 sites preserve full SVG properties, markup, timing and idle branches', () => {
  for (const site of sites) {
    const before = expressionRunner(site.old), after = expressionRunner(site.expression);
    for (const loading of [false, true]) for (const chipColor of ['#4ade80', '#f87171', 'currentColor']) {
      compareIcon(before(loading, chipColor), after(loading, chipColor));
    }
  }
});
test('only marked HTML owns the loop; the existing square slot, centered origin and exact hidden gate stay in use', () => {
  let directInfiniteSvg = 0;
  function inspect(node) {
    if (ts.isJsxSelfClosingElement(node) && ['RefreshCw', 'Loader2', 'Icon'].includes(node.tagName.getText(ast))) {
      const attribute = name => node.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.text === name)?.initializer?.getText(ast) || '';
      if (attribute('style').includes('infinite') || /\banimate-spin\b/.test(attribute('className'))) directInfiniteSvg++;
    }
    ts.forEachChild(node, inspect);
  }
  inspect(ast);
  assert.equal(directInfiniteSvg, 0);
  for (const Icon of [RefreshCw, Loader2]) for (const size of [10, 11, 12, 13]) {
    const host = UsageSpinner({ icon: Icon, size });
    assert.equal(host.props.style.animation, 'spin 1s linear infinite');
    assert.equal(host.props.style.width, size); assert.equal(host.props.style.height, size);
    assert.equal(host.props.style.transformOrigin, undefined, 'same default centered outer transform origin');
    assert.equal(host.props.style.flexShrink, undefined, 'do not change the original default flex shrink');
    assert.equal(host.props.children.props.size, size);
  }
  const preflight = fs.readFileSync(require.resolve('tailwindcss/preflight.css'), 'utf8');
  assert.match(preflight, /img,\s*svg,[\s\S]*?object\s*\{\s*display: block;/, 'HTML block carrier matches existing SVG block presentation');
  const styleDir = path.join(__dirname, '../../styles');
  const globals = fs.readFileSync(path.join(styleDir, 'globals.css'), 'utf8');
  assert.match(globals, /@import "tailwindcss";/);
  assert.match(globals, /@keyframes spin\s*\{\s*from\s*\{\s*transform: rotate\(0deg\);\s*\}\s*to\s*\{\s*transform: rotate\(360deg\);\s*\}\s*\}/);
  const css = fs.readFileSync(path.join(styleDir, 'presentationAnimations.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const pauseRule = css.slice(0, css.indexOf('}') + 1);
  for (const owner of ['[data-terminal-pane-wrapper][data-terminal-surface-presented="0"]', '[data-terminal-pane-chrome-host][aria-hidden="true"]',
    '[data-single-center-focus-boundary][aria-hidden="true"]', '[data-history-owner][data-history-presented="0"]',
    '[data-tab-sidebar-layer][data-sidebar-presented="0"]', '[data-workspace-presentation][aria-hidden="true"]']) assert.ok(pauseRule.includes(owner));
  assert.match(pauseRule, /\.noted-infinite-animation\s*,/);
  assert.match(pauseRule, /animation-play-state:\s*paused !important/);
  assert.doesNotMatch(pauseRule, /:focus(?:-within|-visible)?\b|svg\b|\[(?:class|style)[*^$|~]?=/);
});
function find(element, predicate) {
  if (!React.isValidElement(element)) return undefined;
  if (predicate(element)) return element;
  for (const child of React.Children.toArray(element.props.children)) {
    const found = find(child, predicate);
    if (found) return found;
  }
}
function normalize(html, siteIndex, loading, chipColor = '#4ade80') {
  const site = sites[siteIndex], before = expressionRunner(site.old)(loading, chipColor), after = expressionRunner(site.expression)(loading, chipColor);
  return html.replace(render(after), render(before));
}
test('actual refresh row preserves error/idle/retry title, ARIA, disabled state, action slot and refresh callback', () => {
  const before = subject('UsageSourceRefreshRow', true), after = subject('UsageSourceRefreshRow');
  for (const loading of [false, true]) for (const refreshDisabled of [false, true]) for (const refreshError of [null, 'Saved failure']) {
    const calls = [], props = { sourceText: 'Source · stale', loading, refreshDisabled, refreshError, refreshTitle: 'Refresh usage',
      actions: React.createElement('span', { 'data-fixture-action': true }, 'account action'), onRefresh: () => calls.push('refresh') };
    const oldRow = before(props), currentRow = after(props), oldHtml = render(oldRow), currentHtml = render(currentRow);
    assert.equal(normalize(currentHtml, 0, loading), oldHtml, 'complete row changes only the rotating icon');
    const oldButton = find(oldRow, node => node.type === 'button'), button = find(currentRow, node => node.type === 'button');
    const { children: oldChildren, ...oldProps } = oldButton.props, { children, ...currentProps } = button.props;
    assert.deepEqual({ ...currentProps, onClick: null }, { ...oldProps, onClick: null });
    assert.equal(button.props.disabled, refreshDisabled);
    assert.equal(button.props['aria-busy'], loading);
    assert.equal(button.props['data-usage-refresh-state'], refreshError ? 'error' : loading ? 'loading' : 'idle');
    if (!refreshDisabled) {
      let stops = 0;
      for (const item of [oldButton, button]) item.props.onClick({ stopPropagation() { stops++; } });
      assert.equal(stops, 2); assert.deepEqual(calls, ['refresh', 'refresh']);
    }
  }
});
test('actual shared activity preserves expanded/loading/error/static content, refresh slot and callbacks', () => {
  // The unchanged activity list is an inert SSR substitute; no usage/provider reads.
  const scope = { ActivityView: () => React.createElement('div', { 'data-activity-fixture': true }, 'activity') };
  const before = subject('SharedActivitySection', true, scope), after = subject('SharedActivitySection', false, scope);
  for (const expanded of [false, true]) for (const loading of [false, true]) for (const activity of [null, { ok: false, error: 'Saved activity error' }, { ok: true }]) {
    const calls = [], props = { expanded, loading, activity, onToggle: () => calls.push('toggle'), onRefresh: () => calls.push('refresh') };
    const oldRow = before(props), row = after(props);
    assert.equal(normalize(render(row), 10, loading), render(oldRow));
    const oldToggle = find(oldRow, node => node.type === 'button' && node.props['aria-expanded'] !== undefined);
    const toggle = find(row, node => node.type === 'button' && node.props['aria-expanded'] !== undefined);
    oldToggle.props.onClick(); toggle.props.onClick();
    assert.deepEqual(calls, ['toggle', 'toggle']);
    const oldRefresh = find(oldRow, node => node.type === 'button' && node.props.title === 'Refresh activity');
    const refresh = find(row, node => node.type === 'button' && node.props.title === 'Refresh activity');
    assert.equal(Boolean(refresh), expanded);
    if (refresh) {
      assert.equal(refresh.props.disabled, loading);
      assert.deepEqual(refresh.props.style, oldRefresh.props.style);
      if (!loading) {
        let stops = 0;
        for (const button of [oldRefresh, refresh]) button.props.onClick({ stopPropagation() { stops++; } });
        assert.equal(stops, 2); assert.deepEqual(calls.slice(2), ['refresh', 'refresh']);
      }
    }
  }
});
test('actual device login and account action buttons retain their hit slots, nonloading glyphs and exact action arguments', () => {
  const loaderSites = sites.map((site, index) => ({ ...site, index })).filter(site => site.old.startsWith('<Loader2'));
  assert.equal(loaderSites.length, 5);
  for (const site of loaderSites) for (const busy of [false, true]) {
    let buttonNode = site.node.parent;
    while (buttonNode && !(ts.isJsxElement(buttonNode) && buttonNode.openingElement.tagName.getText(ast) === 'button')) buttonNode = buttonNode.parent;
    assert.ok(buttonNode, 'actual loader button');
    const calls = [], profile = { profileId: 'P', label: 'Saved account' };
    const scope = { UsageSpinner, profile, selectedProfile: profile, selectedProfileBusy: busy,
      busyProfileId: busy ? 'P' : null, profileAction: busy ? 'new' : null, hasPendingLogin: false, addAccountDisabled: busy,
      onCancelLogin: (...args) => calls.push(['cancelDevice', args]),
      logoutProfile: (...args) => calls.push(['logout', args]),
      cancelProfileLogin: (...args) => calls.push(['cancel', args]),
      startProfileLogin: (...args) => calls.push(['login', args]) };
    const before = evaluate(originalFrame(buttonNode), scope), after = evaluate(buttonNode.getText(ast), scope);
    assert.equal(normalize(render(after), site.index, true), render(before));
    const { children: oldChildren, ...oldProps } = before.props, { children, ...newProps } = after.props;
    assert.deepEqual({ ...newProps, onClick: null }, { ...oldProps, onClick: null });
    if (!busy) {
      let stops = 0;
      before.props.onClick({ stopPropagation() { stops++; } }); after.props.onClick({ stopPropagation() { stops++; } });
      assert.equal(stops, 2); assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
      const label = after.props['aria-label'];
      const expected = label.startsWith('Sign out ') ? ['logout', [profile]]
        : label === 'Sign in to Codex' ? ['login', ['P']]
          : label === 'Connect another Codex account' ? ['login', []]
            : site.owner === 'CodexDeviceLoginSection' ? ['cancelDevice', ['P']] : ['cancel', ['P']];
      assert.deepEqual(calls[1], expected);
    }
  }
});

